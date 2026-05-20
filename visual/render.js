// visual/render.js — WEBGL voxel point-cloud renderer.
// Per-frame iterates every voxel, skips ones below threshold, draws bright dot
// + bloom halo + (optional) hot-white center for the brightest voxels.
// Ported from volumetric-led/sketch.js:1402-1498 with cleanup.

const RENDER_BG = [4, 4, 8];                  // background fill (dark navy)
const RENDER_BLOOM_THRESH = 0.12;
const RENDER_CORE_THRESH = 0.025;
const RENDER_HOT_THRESH = 0.55;

// Apply the additive blend GL state so glow stacks naturally instead of
// occluding. Restore default blend at end of pass.
function renderVoxels(p, hideBand) {
  const gl = p.drawingContext;
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

  const G = VOXEL_GRID;
  const S = VOXEL_SPACING;
  const half = G / 2;
  const N = VOXEL_COUNT;

  p.noFill();

  // Single merged pass: bloom halo + core dot + hot-white peak per voxel.
  // Iterating once over the flat array and computing xyz from the index is
  // measurably faster than triple-nested loops in the JIT.
  for (let i = 0; i < N; i++) {
    const structure = voxStructure[i];
    const signal = voxSignal[i];
    // Cheap visual "breath" — scale structure brightness a touch with
    // global volume so quiet passages dim the dendrite skeleton.
    const b = Math.min(1, structure * (0.3 + globalBreath * 0.7) + signal);
    if (b < RENDER_CORE_THRESH) continue;

    const ci = i * 3;
    let r = voxColor[ci];
    let g = voxColor[ci + 1];
    let bl = voxColor[ci + 2];

    // Hide-band toggle: skip voxels whose owning color matches a band entry
    // (entity voxels have entityPalette colors, never matching a band rgb
    // exactly because we paint first-painter-wins). Approximation, not exact.
    if (hideBand && structure > signal * 0.5) {
      // entity colors all have at least one channel >= 200 from entityPalette;
      // bands are HSL-derived, often more balanced. Quick heuristic: skip if
      // owning voxel was painted by a band neuron (max channel < 220 typical).
      const maxCh = Math.max(r, g, bl);
      if (maxCh < 215) continue;
    }

    // Compute (x,y,z) from flat index. Layout: idx = z*G² + y*G + x.
    const z = (i / (G * G)) | 0;
    const rem = i - z * G * G;
    const y = (rem / G) | 0;
    const x = rem - y * G;
    const px = (x - half + 0.5) * S;
    const py = (y - half + 0.5) * S;
    const pz = (z - half + 0.5) * S;

    // Bloom halo — big soft point with low alpha.
    if (b >= RENDER_BLOOM_THRESH) {
      p.strokeWeight(b * 16 + 4);
      p.stroke(r, g, bl, b * 32);
      p.point(px, py, pz);
    }

    // Core bright dot.
    const coreSize = 2 + b * 4;
    const alpha = 60 + b * 195;
    p.strokeWeight(coreSize);
    p.stroke(r, g, bl, alpha);
    p.point(px, py, pz);

    // Hot-white peak — only for the brightest voxels (action-potential heads).
    if (b > RENDER_HOT_THRESH) {
      const wb = (b - RENDER_HOT_THRESH) / (1 - RENDER_HOT_THRESH);
      p.strokeWeight(coreSize * 0.45);
      p.stroke(
        r + (255 - r) * wb * 0.75,
        g + (255 - g) * wb * 0.75,
        bl + (255 - bl) * wb * 0.75,
        b * 180
      );
      p.point(px, py, pz);
    }
  }

  // Restore default blend + depth so the cube wireframe and HUD render right.
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.DEPTH_TEST);

  // Faint enclosure wireframe — anchors the eye, reads as the "LED cube" shell.
  p.push();
  p.noFill();
  p.stroke(28, 28, 36);
  p.strokeWeight(0.8);
  const total = G * S;
  p.box(total, total, total);
  p.pop();
}
