// visual/bursts.js — ephemeral threshold-triggered neural bursts.
// Replaces the prior persistent-neuron model. Each time a band or entity
// detector crosses its threshold (with a refractory gate), a fresh Burst is
// spawned: a short-lived dendrite tree that walks outward from a soma, fades
// in over ~5 frames, sustains, then fades out by lifespan-end.
//
// Per-burst color diffusion (v6 aesthetic): the soma is its source's primary
// color; voxels further down the tree lerp toward a "secondary" color taken
// from a neighboring v6 palette hue. So each burst reads as a colored core
// radiating into a different hue at its branch tips — the v6 cluster-drift
// feel translated into 3D.

const BURSTS = [];                  // live bursts; sketch.js culls dead ones each frame
const BURST_CAP = 80;               // hard cap; oldest culled when over
const DEFAULT_BURST_LEN = 90;       // dendrite-walk steps (deduped to ~50-70 voxels)
let burstRng = 0xB17C;

function burstRand() {
  burstRng = (burstRng * 1664525 + 1013904223) >>> 0;
  return burstRng / 0x100000000;
}

// 6-neighbor random walk biased slightly outward from cube center. Same
// algorithm as the prior persistent-neuron walker (it produced satisfying
// branchy paths), now invoked per-burst at spawn time.
function _walkBurstDendrite(sx, sy, sz, len) {
  const path = [];
  const visited = new Set();
  let x = sx, y = sy, z = sz;
  const cx = (VOXEL_GRID - 1) / 2;
  const cy = (VOXEL_GRID - 1) / 2;
  const cz = (VOXEL_GRID - 1) / 2;
  for (let i = 0; i < len; i++) {
    const vi = voxIdx(x, y, z);
    if (!visited.has(vi)) { path.push(vi); visited.add(vi); }
    const ox = x - cx, oy = y - cy, oz = z - cz;
    const cand = [
      { dx:  1, dy: 0, dz: 0, w: 1 + Math.max(0, ox) * 0.15 },
      { dx: -1, dy: 0, dz: 0, w: 1 + Math.max(0, -ox) * 0.15 },
      { dx: 0, dy:  1, dz: 0, w: 1 + Math.max(0, oy) * 0.15 },
      { dx: 0, dy: -1, dz: 0, w: 1 + Math.max(0, -oy) * 0.15 },
      { dx: 0, dy: 0, dz:  1, w: 1 + Math.max(0, oz) * 0.15 },
      { dx: 0, dy: 0, dz: -1, w: 1 + Math.max(0, -oz) * 0.15 }
    ];
    let total = 0; for (const c of cand) total += c.w;
    let pick = burstRand() * total;
    let chosen = cand[0];
    for (const c of cand) { pick -= c.w; if (pick <= 0) { chosen = c; break; } }
    const nx = x + chosen.dx, ny = y + chosen.dy, nz = z + chosen.dz;
    if (voxInBounds(nx, ny, nz)) { x = nx; y = ny; z = nz; }
  }
  return path;
}

class Burst {
  // soma: {x,y,z} integer voxel coords
  // somaColor / secondaryColor: [r,g,b] 0..255 each
  // opts: { intensity (0..1), lifespan (frames), apFrames, kind, label, treeLen }
  constructor(soma, somaColor, secondaryColor, opts) {
    const o = opts || {};
    this.kind = o.kind || "burst";              // "band" | "entity" | freeform
    this.label = o.label || this.kind;          // for debug/HUD ("Sub Bass", "kick", etc.)
    this.somaColor = somaColor;
    this.secondary = secondaryColor;
    this.intensity = o.intensity != null ? o.intensity : 1;
    this.lifespan = o.lifespan || 90;
    this.apFrames = o.apFrames || 20;
    this.age = 0;
    this.apProg = 0;
    this.dead = false;

    this.tree = _walkBurstDendrite(soma.x, soma.y, soma.z,
                                   o.treeLen || DEFAULT_BURST_LEN);
    const L = this.tree.length;

    // Precompute per-voxel color along the tree: lerp soma → secondary by path
    // distance. i=0 = pure soma; i=L-1 = pure secondary. That's the "center
    // is one color, branches diffuse" v6 aesthetic.
    this.colors = new Array(L);
    for (let i = 0; i < L; i++) {
      const t = L > 1 ? i / (L - 1) : 0;
      this.colors[i] = [
        somaColor[0] * (1 - t) + secondaryColor[0] * t,
        somaColor[1] * (1 - t) + secondaryColor[1] * t,
        somaColor[2] * (1 - t) + secondaryColor[2] * t
      ];
    }
  }

  // Per-frame step. Returns true when the burst has fully died.
  step() {
    this.age++;
    if (this.age > this.lifespan) { this.dead = true; return true; }

    // Envelope: fast attack (5 frames in), then slow decay over remaining
    // lifespan. Gives that "punch then fade" neural-burst feel.
    const ATTACK = 5;
    const lifeT = this.age / this.lifespan;
    let env;
    if (this.age < ATTACK) env = this.age / ATTACK;
    else env = 1 - ((this.age - ATTACK) / (this.lifespan - ATTACK));
    env = Math.max(0, env);
    const energy = this.intensity * env;

    const L = this.tree.length;

    // Always paint the soma at full brightness (relative to current energy),
    // so the center color is always strongest and recognizable.
    {
      const vi = this.tree[0];
      if (voxStructure[vi] < energy) voxStructure[vi] = energy;
      paintVoxelColor(vi, this.somaColor);
    }

    // Light dendrite structure proportional to energy, falling off slightly
    // along the path. Each voxel takes this burst's pre-computed color (last
    // writer wins → overlapping bursts mix as the visible color flickers in
    // proportion to whichever burst owns the most recent paint).
    const structFalloff = 0.55;
    for (let i = 1; i < L; i++) {
      const dist = i / L;
      const want = energy * (1 - dist * structFalloff);
      const vi = this.tree[i];
      if (voxStructure[vi] < want) voxStructure[vi] = want;
      paintVoxelColor(vi, this.colors[i]);
    }

    // Advance the action potential along the tree. Narrow bright window so
    // it reads as a moving pulse, peak at the head, trailing edge.
    if (this.apProg < 1) {
      this.apProg = Math.min(1, this.apProg + 1 / this.apFrames);
      const head = Math.floor(this.apProg * (L - 1));
      const W = 5;
      for (let k = -W; k <= W; k++) {
        const i = head + k;
        if (i < 0 || i >= L) continue;
        const falloff = 1 - Math.abs(k) / W;
        const want = energy * falloff * (k <= 0 ? 1 : 0.7);
        const vi = this.tree[i];
        if (voxSignal[vi] < want) voxSignal[vi] = want;
      }
    }

    return false;
  }
}

// Spawn helper — sketch.js calls this from its threshold-cross logic.
// Returns the new burst (or null if at cap).
function spawnBurst(soma, somaColor, secondaryColor, opts) {
  if (BURSTS.length >= BURST_CAP) {
    // Cull the oldest to make room. Oldest = first in array (spawns append).
    BURSTS.shift();
  }
  const b = new Burst(soma, somaColor, secondaryColor, opts);
  BURSTS.push(b);
  return b;
}

// Per-frame step-all + cull dead. Called once per draw().
function stepBursts() {
  for (let i = BURSTS.length - 1; i >= 0; i--) {
    const dead = BURSTS[i].step();
    if (dead) BURSTS.splice(i, 1);
  }
}
