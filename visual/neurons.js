// visual/neurons.js — Neuron objects + pre-walked dendrite trees.
// A neuron owns:
//   soma:    integer (x,y,z) voxel position
//   tree:    Array of voxel indices reachable from the soma by random walk,
//            roughly ordered by distance — so an action potential can step
//            through it in order, lighting voxels in sequence.
//   color:   [r,g,b] for this neuron's owned voxels
//   energy:  smoothed firing level (0..1) — drives soma + dendrite brightness
//   firing:  active AP envelope (0..1), decays per frame
//   apProg:  0..1 progress of the current AP along the tree
// Differences from volumetric-led mode 5: trees are pre-walked at startup
// (deterministic per-seed) instead of grown organically — cheaper per frame
// and lets each neuron own a stable color region.

const NEURONS = [];           // populated by buildNeurons()
const DENDRITE_LEN = 110;     // ~voxels per tree — long enough to read as a branching path
let neuronRng = 0xC0FFEE;

function nrand() {
  // Deterministic LCG so re-builds with the same seed give the same trees.
  neuronRng = (neuronRng * 1664525 + 1013904223) >>> 0;
  return neuronRng / 0x100000000;
}

// Build a random-walk dendrite tree starting at (sx,sy,sz). Wanders the grid
// with a slight outward bias so the tree spreads through the cube instead of
// collapsing back on itself. Returns ordered voxel indices.
function walkDendrite(sx, sy, sz, len) {
  const path = [];
  const visited = new Set();
  let x = sx, y = sy, z = sz;
  const cx = (VOXEL_GRID - 1) / 2;
  const cy = (VOXEL_GRID - 1) / 2;
  const cz = (VOXEL_GRID - 1) / 2;
  for (let i = 0; i < len; i++) {
    const vi = voxIdx(x, y, z);
    if (!visited.has(vi)) {
      path.push(vi);
      visited.add(vi);
    }
    // 6-neighbor step, weighted slightly outward from the cube center.
    const ox = x - cx, oy = y - cy, oz = z - cz;
    const candidates = [
      { dx:  1, dy: 0, dz: 0, w: 1 + Math.max(0, ox) * 0.15 },
      { dx: -1, dy: 0, dz: 0, w: 1 + Math.max(0, -ox) * 0.15 },
      { dx: 0, dy:  1, dz: 0, w: 1 + Math.max(0, oy) * 0.15 },
      { dx: 0, dy: -1, dz: 0, w: 1 + Math.max(0, -oy) * 0.15 },
      { dx: 0, dy: 0, dz:  1, w: 1 + Math.max(0, oz) * 0.15 },
      { dx: 0, dy: 0, dz: -1, w: 1 + Math.max(0, -oz) * 0.15 }
    ];
    let total = 0; for (const c of candidates) total += c.w;
    let pick = nrand() * total;
    let chosen = candidates[0];
    for (const c of candidates) { pick -= c.w; if (pick <= 0) { chosen = c; break; } }
    const nx = x + chosen.dx, ny = y + chosen.dy, nz = z + chosen.dz;
    if (voxInBounds(nx, ny, nz)) { x = nx; y = ny; z = nz; }
  }
  return path;
}

class Neuron {
  constructor(kind, name, soma, color) {
    this.kind = kind;       // "band" | "entity"
    this.name = name;
    this.soma = soma;       // {x,y,z}
    this.color = color;     // [r,g,b]
    this.tree = walkDendrite(soma.x, soma.y, soma.z, DENDRITE_LEN);
    this.energy = 0;
    this.firing = 0;
    this.apProg = 0;
    // Paint owned voxels with this neuron's color (first-painter wins, so
    // earlier-built neurons own their roots even where trees overlap).
    for (const vi of this.tree) {
      const ci = vi * 3;
      if (voxColor[ci] === 0 && voxColor[ci + 1] === 0 && voxColor[ci + 2] === 0) {
        paintVoxelColor(vi, color);
      }
    }
  }

  // Excite the neuron. `level` 0..1. Entity neurons fire discretely (each new
  // hit launches an AP); band neurons mostly modulate brightness continuously
  // and only launch an AP on big spikes.
  fire(level) {
    if (level <= 0.02) return;
    this.energy = Math.max(this.energy, Math.min(1, level));
    if (this.kind === "entity" && level > 0.25 && this.apProg >= 0.95) {
      this.apProg = 0;        // launch a new AP from the soma
      this.firing = 1;
    } else if (this.kind === "band" && level > 0.6 && this.apProg >= 0.95) {
      this.apProg = 0;
      this.firing = 0.6;
    }
  }

  // Per-frame step. Smoothly decays energy, advances any active AP along the
  // tree, lights dendrite voxels (structure) + AP voxels (signal).
  step() {
    this.energy *= 0.88;
    this.firing *= 0.92;

    // Always glow the soma a touch so neurons are findable at rest.
    const somaVi = voxIdx(this.soma.x, this.soma.y, this.soma.z);
    const somaGlow = (this.kind === "entity" ? 0.10 : 0.04) + this.energy * 0.7;
    if (voxStructure[somaVi] < somaGlow) voxStructure[somaVi] = somaGlow;

    // Light dendrite structure proportional to energy. Falls off along the
    // tree so the soma stays brightest and distal branches stay subtle.
    const struct = this.energy * (this.kind === "entity" ? 0.85 : 0.45);
    const L = this.tree.length;
    for (let i = 0; i < L; i++) {
      const tprog = i / L;
      const want = struct * (1 - tprog * 0.7);   // distal end ~30% of soma
      const vi = this.tree[i];
      if (voxStructure[vi] < want) voxStructure[vi] = want;
    }

    // Advance the action potential. The AP is a narrow bright bump that
    // traverses the tree in `apFrames` frames, lighting voxSignal[] along
    // a small window so it reads as a moving pulse instead of a single voxel.
    if (this.apProg < 1) {
      const apFrames = this.kind === "entity" ? 22 : 14;
      this.apProg = Math.min(1, this.apProg + 1 / apFrames);
      const head = Math.floor(this.apProg * (L - 1));
      const windowSize = 6;
      for (let k = -windowSize; k <= windowSize; k++) {
        const i = head + k;
        if (i < 0 || i >= L) continue;
        const falloff = 1 - Math.abs(k) / windowSize;   // triangular pulse
        const want = this.firing * falloff * (k <= 0 ? 1 : 0.8);
        const vi = this.tree[i];
        if (voxSignal[vi] < want) voxSignal[vi] = want;
      }
    }
  }
}

// Build the full neuron constellation. 14 dim band-neurons on an outer ring
// (angular positions match v6's color-wheel ordering) + 7 bright entity
// neurons clustered inside (positions deliberately spread so each entity is
// visually findable).
function buildNeurons() {
  NEURONS.length = 0;
  if (voxColor) voxColor.fill(0);   // clear ownership so re-builds repaint cleanly

  const cx = (VOXEL_GRID - 1) / 2;
  const cy = (VOXEL_GRID - 1) / 2;
  const cz = (VOXEL_GRID - 1) / 2;

  // 14 band neurons on a horizontal ring (y near center, x/z on a circle).
  // Angular position preserves v6's color-wheel layout — sector i sits at
  // 2π·i/14, hue maps directly to angle around the cube.
  const bandRadius = (VOXEL_GRID - 3) / 2;
  for (let i = 0; i < frequencyRanges.length; i++) {
    const r = frequencyRanges[i];
    const angle = (i / frequencyRanges.length) * Math.PI * 2;
    const sx = Math.round(cx + Math.cos(angle) * bandRadius);
    const sz = Math.round(cz + Math.sin(angle) * bandRadius);
    // Vertically stratify by group — bass low, mid mid, high high.
    const yOffset = r.group === "bass" ? 3 : r.group === "high" ? -3 : 0;
    const sy = Math.max(1, Math.min(VOXEL_GRID - 2, Math.round(cy + yOffset)));
    NEURONS.push(new Neuron("band", r.name, { x: sx, y: sy, z: sz }, r.rgb));
  }

  // 7 entity neurons in an inner constellation. Hand-placed so kick sits low
  // (felt in the gut), voice sits at eye level, hat sits high (perceived
  // brightness), brass off to one side, synth deep, pad spread.
  const inner = bandRadius * 0.45;
  const entities = [
    { name: "kick",  pos: [cx,         cy + 3, cz        ] },   // bottom-center
    { name: "snare", pos: [cx + inner, cy + 1, cz        ] },
    { name: "hat",   pos: [cx,         cy - 3, cz + inner] },   // top, forward
    { name: "voice", pos: [cx,         cy,     cz - inner] },   // center, back
    { name: "brass", pos: [cx - inner, cy,     cz + inner * 0.6] },
    { name: "synth", pos: [cx + inner * 0.7, cy - 1, cz - inner * 0.7] },
    { name: "pad",   pos: [cx - inner * 0.6, cy - 2, cz - inner * 0.3] }
  ];
  for (const e of entities) {
    const sx = Math.max(1, Math.min(VOXEL_GRID - 2, Math.round(e.pos[0])));
    const sy = Math.max(1, Math.min(VOXEL_GRID - 2, Math.round(e.pos[1])));
    const sz = Math.max(1, Math.min(VOXEL_GRID - 2, Math.round(e.pos[2])));
    NEURONS.push(new Neuron("entity", e.name, { x: sx, y: sy, z: sz }, entityPalette[e.name]));
  }
}

function rebuildNeurons(newSeed) {
  if (newSeed != null) neuronRng = newSeed >>> 0;
  else neuronRng = (Date.now() * 2654435761) >>> 0;
  buildNeurons();
}
