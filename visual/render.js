// visual/render.js — WEBGL voxel point-cloud renderer.
// Two-stage pipeline:
//   1. Pre-filter: iterate the full voxel grid once, build a tight list of
//      lit voxels (typically ~500-2000 of 32768 at GRID=32). If the list
//      exceeds MAX_RENDER_VOXELS, sort by brightness and keep only the top N.
//      Bounds the expensive WebGL draw-call count regardless of grid size.
//   2. Render: per lit voxel, stack four additive-blended passes —
//        a) outer atmospheric glow (wide, very low alpha) — fires on every
//           lit voxel, so the whole field has a soft volumetric haze even
//           when most voxels are dim
//        b) inner bloom halo (medium width, low alpha) — gates above
//           RENDER_BLOOM_THRESH
//        c) core bright dot
//        d) hot-white peak — only for the brightest voxels (AP heads)
// Ported and extended from volumetric-led/sketch.js:1402-1498.

const RENDER_BG = [4, 4, 8];
const RENDER_BLOOM_THRESH = 0.06;       // bloom now fires for nearly all lit voxels
const RENDER_CORE_THRESH  = 0.018;      // global "is this voxel worth drawing"
const RENDER_HOT_THRESH   = 0.55;       // hot-white peak only for AP heads
const MAX_RENDER_VOXELS   = 40000;      // hard cap on draw budget per frame (sized for GRID=160)

// Reusable scratch buffer — avoid GC pressure by holding a flat lit-list
// across frames. Each entry is 7 contiguous numbers:
//   [voxIdx, total-brightness, signal-brightness, r, g, b, depthFrac]
// depthFrac (0=core, 1=tip) drives a per-voxel thickness multiplier so
// trunks render fat and tips render fine.
const _litBuf = new Float32Array(MAX_RENDER_VOXELS * 7);
let _litCount = 0;
// Adaptive brightness threshold. Starts at RENDER_CORE_THRESH and creeps
// upward whenever a frame fills the lit-buffer to capacity (so the dimmest
// voxels get culled first instead of the youngest-by-iteration-order). When
// frames run well under capacity, it relaxes back toward the base. Result:
// over-cap moments cull dim background haze rather than chopping bright
// AP heads, and the budget stays bounded regardless of grid size.
let _dynThresh = RENDER_CORE_THRESH;
const _BASE_THRESH = RENDER_CORE_THRESH;
const _MAX_THRESH = 0.45;

function renderVoxels(p, _hideBandUnused) {
  const gl = p.drawingContext;
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

  const G = VOXEL_GRID;
  const S = VOXEL_SPACING;
  const half = G / 2;
  const N = VOXEL_COUNT;

  // ─── Stage 1: prefilter to lit voxels with adaptive threshold ───
  let count = 0;
  const buf = _litBuf;
  const breath = (0.3 + globalBreath * 0.7);
  const cap = MAX_RENDER_VOXELS;
  const thresh = _dynThresh;

  for (let i = 0; i < N; i++) {
    const structure = voxStructure[i];
    const signal = voxSignal[i];
    if (structure === 0 && signal === 0) continue;     // fast reject zero voxels
    let b = structure * breath + signal;
    if (b > 1) b = 1;
    if (b < thresh) continue;

    if (count < cap) {
      const w = count * 7;
      const ci = i * 3;
      buf[w]     = i;
      buf[w + 1] = b;
      buf[w + 2] = signal;
      buf[w + 3] = voxColor[ci];
      buf[w + 4] = voxColor[ci + 1];
      buf[w + 5] = voxColor[ci + 2];
      buf[w + 6] = voxDepth[i];                  // 0..255 depth byte
      count++;
    }
    // else: skip and let _dynThresh climb next frame so the dimmest go first
  }

  // Adaptive feedback: climb threshold when at capacity (dim voxels culled
  // before bright ones), relax when well under capacity (no wasted budget).
  // 8% per frame converges in ~10 frames (~170ms) — fast enough to hide
  // the transition during sudden burst floods, slow enough not to flicker.
  if (count >= cap) {
    _dynThresh = Math.min(_MAX_THRESH, _dynThresh * 1.08);
  } else if (count < cap * 0.55) {
    _dynThresh = Math.max(_BASE_THRESH, _dynThresh * 0.92);
  }
  _litCount = count;

  // ─── Stage 2: render ────────────────────────────────────────────
  // Two visual classes of lit voxel:
  //   - structure-dominant (signal small): persistent dendrite trail —
  //     render as a CRISP small dot with only a tight halo, so branches
  //     read as clean traceable lines, not fog.
  //   - signal-dominant (signal large): the AP wavefront's growing tip —
  //     render with full atmospheric glow + bloom + hot-white peak, so the
  //     growing tip of each branch bursts dramatically.
  p.noFill();

  for (let i = 0; i < count; i++) {
    const w = i * 7;
    const vi = buf[w] | 0;
    const b = buf[w + 1];
    const sig = buf[w + 2];
    const r = buf[w + 3];
    const g = buf[w + 4];
    const bl = buf[w + 5];
    const depthFrac = buf[w + 6] / 255;          // 0=core, 1=tip

    // Per-voxel thickness multiplier from depth: fat trunk (2.2× at core)
    // fining out to thin tips (0.55× at tip). Applied to core dot, bloom
    // halo, AND atmospheric glow so the gradient compounds across passes.
    const thickMult = 2.2 - depthFrac * 1.65;

    // (x,y,z) from flat index, layout z*G² + y*G + x
    const z = (vi / (G * G)) | 0;
    const rem = vi - z * G * G;
    const y = (rem / G) | 0;
    const x = rem - y * G;
    const px = (x - half + 0.5) * S;
    const py = (y - half + 0.5) * S;
    const pz = (z - half + 0.5) * S;

    // Atmospheric glow — gated on signal strength. Only AP-wavefront
    // voxels emit the wide halo. Persistent dendrite voxels stay sharp.
    if (sig > 0.12) {
      p.strokeWeight((sig * 26 + 8) * thickMult);
      p.stroke(r, g, bl, sig * 22);
      p.point(px, py, pz);
    }

    // Inner bloom halo — for any voxel above a moderate brightness.
    // Tighter than before so the structure trail isn't fogged out.
    if (b >= RENDER_BLOOM_THRESH || sig > 0.08) {
      p.strokeWeight((b * 9 + 3) * thickMult);
      p.stroke(r, g, bl, b * 38);
      p.point(px, py, pz);
    }

    // Core bright dot — every lit voxel. Smaller base size so the dendrite
    // structure reads as a chain of distinct dots, not a wash.
    const coreSize = (1.5 + b * 4) * thickMult;
    p.strokeWeight(coreSize);
    p.stroke(r, g, bl, 80 + b * 175);
    p.point(px, py, pz);

    // Hot white peak — AP-wavefront ONLY, brightest tips.
    if (sig > RENDER_HOT_THRESH) {
      const wb = (sig - RENDER_HOT_THRESH) / (1 - RENDER_HOT_THRESH);
      p.strokeWeight(coreSize * 0.45);
      p.stroke(
        r + (255 - r) * wb * 0.85,
        g + (255 - g) * wb * 0.85,
        bl + (255 - bl) * wb * 0.85,
        sig * 200
      );
      p.point(px, py, pz);
    }
  }

  // Restore default blend + depth so enclosure wireframe & HUD render right.
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.DEPTH_TEST);

  // Faint enclosure wireframe — the "LED cube" shell anchor.
  p.push();
  p.noFill();
  p.stroke(28, 28, 36);
  p.strokeWeight(0.8);
  const total = G * S;
  p.box(total, total, total);
  p.pop();
}

function renderLitCount() { return _litCount; }
function renderDynamicThreshold() { return _dynThresh; }
