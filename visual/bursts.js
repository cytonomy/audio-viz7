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

// The 6 unit-vector directions in voxel space.
const _DIRS = [
  { dx:  1, dy: 0, dz: 0 },
  { dx: -1, dy: 0, dz: 0 },
  { dx: 0, dy:  1, dz: 0 },
  { dx: 0, dy: -1, dz: 0 },
  { dx: 0, dy: 0, dz:  1 },
  { dx: 0, dy: 0, dz: -1 }
];

// Two directions are perpendicular when their dot product is zero. Pre-
// compute the perpendicular set per direction so split + turn picks are O(1).
const _PERP = _DIRS.map(d =>
  _DIRS.filter(o => o.dx*d.dx + o.dy*d.dy + o.dz*d.dz === 0)
);

// Grow a tree of thin curving tendrils from the soma. N primary branches
// shoot off in random initial directions. Each branch advances one voxel
// per step in its current direction (momentum), with a small chance per
// step of turning 90° (curve) or splitting (fork). Branches die when they
// hit the cube boundary, run out of life, or get boxed in by visited
// neighbors. Result: distinct, visually-traceable dendrite arms — not
// the bushy BFS sphere it replaces.
function _growExplosion(sx, sy, sz, targetNodes) {
  const nodes = [];
  const depths = [];
  const visited = new Set();

  const somaVi = voxIdx(sx, sy, sz);
  visited.add(somaVi);
  nodes.push(somaVi);
  depths.push(0);
  let maxDepth = 0;

  // Per-burst tuning knobs. Tuned for clearly-visible thin tendrils — NOT
  // bushy explosions. Split probability is intentionally low so branch
  // count stays bounded; high split rates compound exponentially and turn
  // the burst back into a dense ball.
  //   PRIMARY_COUNT: how many arms shoot off from soma
  //   TURN_PROB:     chance per step a branch turns 90°
  //   SPLIT_PROB:    chance per step a branch forks (kept rare)
  //   BRANCH_LIFE:   max steps a single branch lives
  //   MAX_BRANCHES:  hard cap on simultaneous live branches
  //   MAX_PER_SHELL: rejects new steps when a depth shell is already full
  //                  → forces branches to spread laterally instead of
  //                  piling onto the same depth
  const PRIMARY_COUNT = 4 + Math.floor(burstRand() * 2);     // 4-5 arms
  const TURN_PROB = 0.18;
  const SPLIT_PROB = 0.022;
  const BRANCH_LIFE = Math.max(20, Math.round(VOXEL_GRID * 1.2));
  const MAX_BRANCHES = 7;
  const MAX_PER_SHELL = 8;

  // Active branch heads. Each branch advances one voxel per outer loop pass.
  const branches = [];
  // Pick PRIMARY_COUNT distinct initial directions so arms don't overlap.
  const dirOrder = _DIRS.slice();
  for (let i = dirOrder.length - 1; i > 0; i--) {
    const j = Math.floor(burstRand() * (i + 1));
    const t = dirOrder[i]; dirOrder[i] = dirOrder[j]; dirOrder[j] = t;
  }
  for (let i = 0; i < PRIMARY_COUNT; i++) {
    branches.push({
      x: sx, y: sy, z: sz,
      dir: dirOrder[i % 6],
      depth: 0,
      life: BRANCH_LIFE
    });
  }

  // Per-depth-shell occupancy counter — used to reject new steps into a
  // shell that's already at MAX_PER_SHELL. Keeps tendrils thin.
  const shellCount = new Map();
  shellCount.set(0, 1);     // soma occupies depth 0

  // Iterate until we have enough nodes or all branches died.
  let safety = targetNodes * 4;     // hard guard against runaway loops
  while (nodes.length < targetNodes && branches.length > 0 && safety-- > 0) {
    for (let bi = branches.length - 1; bi >= 0; bi--) {
      if (nodes.length >= targetNodes) break;
      const b = branches[bi];
      if (b.life <= 0) { branches.splice(bi, 1); continue; }

      // Pick this step's direction. With TURN_PROB chance, swap to a
      // perpendicular axis (90° turn). Otherwise continue straight.
      let stepDir = b.dir;
      if (burstRand() < TURN_PROB) {
        const perps = _PERP[_DIRS.indexOf(b.dir)];
        stepDir = perps[Math.floor(burstRand() * perps.length)];
      }

      // Try the step. If blocked (out-of-bounds or visited), try one
      // alternative direction once, else this branch dies.
      let nx = b.x + stepDir.dx;
      let ny = b.y + stepDir.dy;
      let nz = b.z + stepDir.dz;
      let nvi = voxInBounds(nx, ny, nz) ? voxIdx(nx, ny, nz) : -1;
      if (nvi === -1 || visited.has(nvi)) {
        // Try a different direction
        let recovered = false;
        for (let k = 0; k < 6; k++) {
          const alt = _DIRS[(Math.floor(burstRand() * 6))];
          if (alt === stepDir) continue;
          const ax = b.x + alt.dx, ay = b.y + alt.dy, az = b.z + alt.dz;
          if (!voxInBounds(ax, ay, az)) continue;
          const avi = voxIdx(ax, ay, az);
          if (visited.has(avi)) continue;
          stepDir = alt; nx = ax; ny = ay; nz = az; nvi = avi;
          recovered = true;
          break;
        }
        if (!recovered) { branches.splice(bi, 1); continue; }
      }

      // Per-shell cap — if this depth is already full, kill the branch.
      // Forces thin tendrils instead of bushy shells.
      const newDepth = b.depth + 1;
      const occ = shellCount.get(newDepth) || 0;
      if (occ >= MAX_PER_SHELL) { branches.splice(bi, 1); continue; }

      // Advance
      b.x = nx; b.y = ny; b.z = nz;
      b.dir = stepDir;
      b.depth = newDepth;
      b.life--;
      visited.add(nvi);
      nodes.push(nvi);
      depths.push(newDepth);
      shellCount.set(newDepth, occ + 1);
      if (newDepth > maxDepth) maxDepth = newDepth;

      // Possible split — spawn a sub-branch in a perpendicular direction.
      // Only past depth 4 (splits at the soma turn into bushy core) and
      // bounded by MAX_BRANCHES so total live arms stays manageable.
      if (newDepth > 4 && burstRand() < SPLIT_PROB && branches.length < MAX_BRANCHES) {
        const perps = _PERP[_DIRS.indexOf(stepDir)];
        const splitDir = perps[Math.floor(burstRand() * perps.length)];
        branches.push({
          x: nx, y: ny, z: nz,
          dir: splitDir,
          depth: newDepth,
          life: Math.max(8, (b.life * 0.65) | 0)
        });
      }
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

    // Advance the AP wavefront FIRST so structure + signal both see the new
    // wave position this frame.
    if (this.apProg < 1) {
      this.apProg = Math.min(1, this.apProg + 1 / this.apFrames);
    }
    const waveDepth = this.apProg * (this.maxDepth + 1);

    const N = this.nodes.length;

    // Dendrite structure pass — voxels are ONLY lit once the wavefront has
    // reached their depth. That's the "grow" effect: as the wave expands
    // outward over apFrames frames, more of the tree becomes visible.
    // Voxels ahead of the wave stay dark — they "haven't grown yet."
    // Brightness still tapers with depth so tips read as faint.
    const structFalloff = 0.5;
    for (let i = 0; i < N; i++) {
      const d = this.depths[i];
      if (d > waveDepth) continue;                         // not yet grown
      const t = d / this.maxDepth;
      const want = energy * (1 - t * structFalloff);
      const vi = this.nodes[i];
      if (voxStructure[vi] < want) voxStructure[vi] = want;
      paintVoxelColor(vi, this.colors[i]);
    }

    // Action potential pass — bright shell at the wavefront so the GROWING
    // TIP of every branch glows extra brightly. Width is narrow (1.6 depth
    // units) so it reads as a thin advancing edge, not a thick blob.
    if (this.apProg < 1) {
      const W = 1.6;
      for (let i = 0; i < N; i++) {
        const d = this.depths[i];
        const dist = Math.abs(d - waveDepth);
        if (dist >= W) continue;
        const falloff = 1 - dist / W;
        const want = energy * falloff * 1.3;
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
