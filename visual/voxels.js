// visual/voxels.js — volumetric voxel grid state.
// Ported and simplified from volumetric-led/sketch.js around the mode-5
// (NEURONS) data model. Two Float32Array buffers per voxel:
//   structure[]  → persistent dendrite-path brightness (slow decay)
//   signal[]     → traveling action-potential brightness (fast decay)
// Each frame, every voxel reads structure[vi] + signal[vi] and the renderer
// turns the sum into a colored, bloomed dot.

// Grid resolution. 32³ = 32768 voxels — 8× denser than the v7.0 default.
// SPACING auto-scales so the on-screen cube stays roughly the same physical
// size regardless of grid; the renderer's lit-voxel pre-filter keeps per-
// frame draw cost bounded even at this resolution.
const VOXEL_GRID = 32;
const VOXEL_SPACING = Math.max(6, Math.floor(350 / VOXEL_GRID));   // ≈11 at GRID=32
const VOXEL_COUNT = VOXEL_GRID * VOXEL_GRID * VOXEL_GRID;

// Allocated by initVoxels(), referenced from sketch.js / render.js / bursts.js.
// voxColor uses Uint8Array — RGB are 0..255 anyway, so this is a 4× memory
// cut vs Float32Array (96 KB instead of 384 KB at GRID=32) and equally fast.
let voxStructure;   // per-voxel dendrite intensity, 0..1
let voxSignal;      // per-voxel action potential intensity, 0..1
let voxColor;       // Uint8Array[VOXEL_COUNT * 3] RGB per voxel (last burst wins)

function initVoxels() {
  voxStructure = new Float32Array(VOXEL_COUNT);
  voxSignal    = new Float32Array(VOXEL_COUNT);
  voxColor     = new Uint8Array(VOXEL_COUNT * 3);
}

// Flat-index helper. Matches volumetric-led layout: idx = z*G² + y*G + x.
function voxIdx(x, y, z) {
  return z * VOXEL_GRID * VOXEL_GRID + y * VOXEL_GRID + x;
}

function voxInBounds(x, y, z) {
  return x >= 0 && x < VOXEL_GRID
      && y >= 0 && y < VOXEL_GRID
      && z >= 0 && z < VOXEL_GRID;
}

// Per-frame decay. structure fades slowly (dendrite "memory"), signals fade fast
// (action potentials are momentary). Cutoffs zero out near-black voxels so the
// renderer can skip them entirely.
function decayVoxels() {
  const structDecay = 0.965;   // ~30-frame half-life — dendrites linger
  const signalDecay = 0.82;    // ~3-frame half-life — APs flash and gone
  for (let i = 0; i < VOXEL_COUNT; i++) {
    voxStructure[i] *= structDecay;
    if (voxStructure[i] < 0.04) voxStructure[i] = 0;
    voxSignal[i] *= signalDecay;
    if (voxSignal[i] < 0.02) voxSignal[i] = 0;
  }
}

// Paint a voxel with a burst's per-step color. Last writer wins, so
// overlapping bursts visibly recolor shared voxels.
function paintVoxelColor(vi, rgb) {
  const ci = vi * 3;
  voxColor[ci]     = rgb[0] | 0;
  voxColor[ci + 1] = rgb[1] | 0;
  voxColor[ci + 2] = rgb[2] | 0;
}
