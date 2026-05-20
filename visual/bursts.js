// visual/bursts.js — ephemeral threshold-triggered neural EXPLOSIONS.
// Each burst is a branching dendrite tree grown BFS from a soma. Action
// potential propagates outward as a spherical wavefront expanding through
// depth shells (NOT along a 1D path) — so every burst reads as a true
// radial explosion of dendrites in all directions, no two ever the same
// shape.
//
// Per-burst color diffusion (v6 aesthetic): the soma + inner shells are
// the source's primary color; outer shells lerp toward a "secondary"
// color taken from a v6 palette neighbor. So each burst reads as a
// colored core radiating into a different hue at its branch tips.

const BURSTS = [];
const BURST_CAP = 80;
// Target unique voxel count per burst. Scales with grid resolution so visual
// density stays consistent. At GRID=16 → 96 nodes; at GRID=32 → 192.
const DEFAULT_BURST_NODES = Math.max(60, Math.round(VOXEL_GRID * 6));
let burstRng = 0xB17C;

function burstRand() {
  burstRng = (burstRng * 1664525 + 1013904223) >>> 0;
  return burstRng / 0x100000000;
}

// Fisher-Yates shuffle into a small fixed array, using burstRand.
const _NB = [null, null, null, null, null, null];
function _shuffledNeighbors() {
  _NB[0] = { dx:  1, dy: 0, dz: 0 };
  _NB[1] = { dx: -1, dy: 0, dz: 0 };
  _NB[2] = { dx: 0, dy:  1, dz: 0 };
  _NB[3] = { dx: 0, dy: -1, dz: 0 };
  _NB[4] = { dx: 0, dy: 0, dz:  1 };
  _NB[5] = { dx: 0, dy: 0, dz: -1 };
  for (let i = 5; i > 0; i--) {
    const j = Math.floor(burstRand() * (i + 1));
    const t = _NB[i]; _NB[i] = _NB[j]; _NB[j] = t;
  }
  return _NB;
}

// Grow a branching tree BFS from the soma. At each node, spawn 1-3 random
// children in unique 6-neighbor directions. Branch factor tapers with depth
// (dense base, thin tips). Pure-random direction with NO outward bias — the
// "explosion" comes from many tendrils spreading in all directions, not from
// preferring an outward direction.
function _growExplosion(sx, sy, sz, targetNodes) {
  const nodes = [];           // ordered list of voxel indices (parents before children)
  const depths = [];          // depth from soma per node
  const visited = new Set();
  // BFS queue of {x, y, z, depth}. Pre-allocated array used as a circular
  // buffer would be ideal; for simplicity use shift() — tree sizes are small
  // (~150 entries) so the O(N²) cost is dwarfed by the JS hash-set lookup.
  const queue = [{ x: sx, y: sy, z: sz, depth: 0 }];
  let maxDepth = 0;

  while (nodes.length < targetNodes && queue.length > 0) {
    const cur = queue.shift();
    const vi = voxIdx(cur.x, cur.y, cur.z);
    if (visited.has(vi)) continue;
    visited.add(vi);
    nodes.push(vi);
    depths.push(cur.depth);
    if (cur.depth > maxDepth) maxDepth = cur.depth;

    // Branch count tapers with depth — soma gets up to 4 branches, tips get
    // just 1. Adds a probabilistic skip so trees aren't perfectly uniform.
    const branchFactor = cur.depth === 0
      ? 3 + Math.floor(burstRand() * 2)        // root: 3-4 children
      : Math.max(1, 3 - Math.floor(cur.depth * 0.18));   // tapers to 1
    const nb = _shuffledNeighbors();
    let added = 0;
    for (let k = 0; k < nb.length && added < branchFactor; k++) {
      const nx = cur.x + nb[k].dx;
      const ny = cur.y + nb[k].dy;
      const nz = cur.z + nb[k].dz;
      if (!voxInBounds(nx, ny, nz)) continue;
      const nvi = voxIdx(nx, ny, nz);
      if (visited.has(nvi)) continue;
      // 88% spawn probability — small gaps add variety, prevent every burst
      // looking like a perfect sphere.
      if (burstRand() > 0.88) continue;
      queue.push({ x: nx, y: ny, z: nz, depth: cur.depth + 1 });
      added++;
    }
  }

  return { nodes, depths, maxDepth: Math.max(1, maxDepth) };
}

class Burst {
  // soma: {x,y,z} integer voxel coords
  // somaColor / secondaryColor: [r,g,b] 0..255 each
  // opts: { intensity, lifespan, apFrames, kind, label, targetNodes }
  constructor(soma, somaColor, secondaryColor, opts) {
    const o = opts || {};
    this.kind = o.kind || "burst";
    this.label = o.label || this.kind;
    this.somaColor = somaColor;
    this.secondary = secondaryColor;
    this.intensity = o.intensity != null ? o.intensity : 1;
    this.lifespan = o.lifespan || 90;
    this.apFrames = o.apFrames || 20;
    this.age = 0;
    this.apProg = 0;
    this.dead = false;

    const grown = _growExplosion(soma.x, soma.y, soma.z,
                                 o.targetNodes || DEFAULT_BURST_NODES);
    this.nodes = grown.nodes;
    this.depths = grown.depths;
    this.maxDepth = grown.maxDepth;

    // Precompute per-node color: lerp soma → secondary by depth/maxDepth.
    // Soma + inner shells are pure soma color; outer shells diffuse toward
    // the secondary hue. Per-shell coloring, not per-path-index — gives the
    // "expanding colored shockwave" feel.
    const N = this.nodes.length;
    this.colors = new Array(N);
    for (let i = 0; i < N; i++) {
      const t = this.depths[i] / this.maxDepth;
      this.colors[i] = [
        somaColor[0] * (1 - t) + secondaryColor[0] * t,
        somaColor[1] * (1 - t) + secondaryColor[1] * t,
        somaColor[2] * (1 - t) + secondaryColor[2] * t
      ];
    }
  }

  step() {
    this.age++;
    if (this.age > this.lifespan) { this.dead = true; return true; }

    // Envelope: fast 5-frame attack, then long decay over the remaining
    // lifespan. "Punch then fade" feel.
    const ATTACK = 5;
    let env;
    if (this.age < ATTACK) env = this.age / ATTACK;
    else env = 1 - ((this.age - ATTACK) / (this.lifespan - ATTACK));
    if (env < 0) env = 0;
    const energy = this.intensity * env;

    const N = this.nodes.length;

    // Soma + inner-shell structure brightness. Falls off with depth so
    // tendril tips read as faint, the core stays bright.
    const structFalloff = 0.55;
    for (let i = 0; i < N; i++) {
      const d = this.depths[i];
      const t = d / this.maxDepth;
      const want = energy * (1 - t * structFalloff);
      const vi = this.nodes[i];
      if (voxStructure[vi] < want) voxStructure[vi] = want;
      paintVoxelColor(vi, this.colors[i]);
    }

    // Action potential: a spherical wavefront expanding outward through
    // depth shells. waveDepth advances each frame from 0 toward maxDepth+1.
    // Voxels within W depth-units of the wave glow brightly in voxSignal;
    // trailing edge is brighter than leading edge so the wave reads as a
    // moving shell, not a single point.
    if (this.apProg < 1) {
      this.apProg = Math.min(1, this.apProg + 1 / this.apFrames);
      const waveDepth = this.apProg * (this.maxDepth + 1);
      const W = 2.0;
      for (let i = 0; i < N; i++) {
        const d = this.depths[i];
        const dist = Math.abs(d - waveDepth);
        if (dist >= W) continue;
        const falloff = 1 - dist / W;
        const trailing = d <= waveDepth ? 1 : 0.6;       // ahead-of-wave dimmer
        const want = energy * falloff * trailing * 1.15;
        const vi = this.nodes[i];
        if (voxSignal[vi] < want) voxSignal[vi] = want;
      }
    }

    return false;
  }
}

function spawnBurst(soma, somaColor, secondaryColor, opts) {
  if (BURSTS.length >= BURST_CAP) BURSTS.shift();   // oldest first out
  const b = new Burst(soma, somaColor, secondaryColor, opts);
  BURSTS.push(b);
  return b;
}

function stepBursts() {
  for (let i = BURSTS.length - 1; i >= 0; i--) {
    if (BURSTS[i].step()) BURSTS.splice(i, 1);
  }
}
