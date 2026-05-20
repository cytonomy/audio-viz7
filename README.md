# audio-viz7 — neural bursts

A 3D volumetric LED visualizer that "sees" what kind of sound is hitting the mic — beat, voice, brass, synth, drums — as distinct neurons firing in a voxel cloud.

Merges the **vibe of `audio-viz6`** (14-band frequency-wheel hue palette, beat peak-hold pulse, touch impulses) with **`volumetric-led` mode 5** (somas, dendrites, action potentials decaying through a 3D voxel grid).

## Three pillars

1. **Noise filtering** — optional RNNoise WASM in an AudioWorklet, with native `noiseSuppression` as fallback. Press `N` to toggle.
2. **Low-latency audio profiling** — Web Audio `AnalyserNode` (FFT 2048) per-frame + Meyda for spectral flux / RMS / sharpness / ZCR + pitchy for monophonic f0 + Silero VAD for voice detection. All ML deps load lazily and degrade gracefully if a CDN fails.
3. **Per-source visual bursts** — 14 dim "band neurons" arranged on a torus ring (continuity with v6's color wheel) + 7 bright "entity neurons" (Kick · Snare · Hat · Voice · Brass · Synth · Pad) at fixed positions. Each fires based on its own detector and bursts an action-potential along its pre-walked dendrite tree.

## Honest framing on "destem"

True live source separation is not solvable in-browser in 2026. We approximate by combining frequency-band heuristics with transient detection; if YAMNet is enabled later it can weight class probabilities. Drums = confident detection. Voice = good. Brass / Synth = "responds when prominently present," not "isolates."

## Run locally

```bash
cd ~/Documents/Code/cytonomy/audio-viz7
python -m http.server 8000
# open http://localhost:8000
```

Tap / click the splash to grant mic permission.

## Keys

- **drag** orbit camera
- **scroll** zoom
- **H** toggle HUD
- **F** fullscreen
- **R** rebuild dendrite trees with a new random seed
- **B** toggle band-ring visibility (entity-only mode)
- **N** toggle noise filter
- **space** pause

## File map

```
index.html              entry + CDN imports
sketch.js               p5 setup/draw, camera, glue
audio/
  loaders.js            lazy ESM deps (Meyda, pitchy, VAD, RNNoise worklet) with graceful fallback
  worklet-rnnoise.js    AudioWorklet processor (lazy)
  profiler.js           AnalyserNode + band rollups (ports audio-viz6 analyzeAudio + getBandEnergy)
  entities.js           Kick/Snare/Hat/Voice/Brass/Synth/Pad firing rules
visual/
  palette.js            14-band hue wheel (ported verbatim from audio-viz6)
  voxels.js             Float32Array grid + decay step (ported from volumetric-led mode 5)
  neurons.js            Neuron class + pre-walked dendrite trees
  render.js             WEBGL voxel point-cloud draw + bloom halo
```

## Lineage

- `audio-viz3` → 2D particle field
- `audio-viz6` → rebalanced palette, swirl, touch impulses, beat pulse envelope
- `volumetric-led` → 3D voxel cloud with 9 modes (mode 5 = NEURONS)
- **`audio-viz7`** → merges v6's vibe + LED mode 5's volume + per-source entity detection
