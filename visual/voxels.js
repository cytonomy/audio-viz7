// visual/voxels.js — volumetric voxel grid state.
// Ported and simplified from volumetric-led/sketch.js around the mode-5
// (NEURONS) data model. Two Float32Array buffers per voxel:
//   structure[]  → persistent dendrite-path brightness (slow decay)
//   signal[]     → traveling action-potential brightness (fast decay)
// Each frame, every voxel reads structure[vi] + signal[vi] and the renderer
// turns the sum into a colored, bloomed dot.

const VOXEL_GRID = 16;                // 16³ = 4096 LEDs (proven default)
const VOXEL_SPACING = 22;
const VOXEL_COUNT = VOXEL_GRID * VOXEL_GRID * VOXEL_GRID;

// Allocated by initVoxels(), referenced from sketch.js / render.js / neurons.js
let voxStructure;   // per-voxel dendrite intensity, 0..1
let voxSignal;      // per-voxel action potential intensity, 0..1
let voxColor;       // Float32Array[VOXEL_COUNT * 3] precomputed RGB per voxel (from owning neuron)

function initVoxels() {
  voxStructure = new Float32Array(VOXEL_COUNT);
  voxSignal    = new Float32Array(VOXEL_COUNT);
  voxColor     = new Float32Array(VOXEL_COUNT * 3);
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

// Paint a voxel with a neuron's color. Called once when a dendrite tree is
// built so each voxel knows which neuron "owns" it for color purposes; later
// fires just modulate brightness without rewriting color.
function paintVoxelColor(vi, rgb) {
  const ci = vi * 3;
  voxColor[ci]     = rgb[0];
  voxColor[ci + 1] = rgb[1];
  voxColor[ci + 2] = rgb[2];
}
