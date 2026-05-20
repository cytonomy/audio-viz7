// audio/loaders.js — lazy ESM dep loaders with graceful fallback.
// Loaded as <script type="module"> from index.html. Each enhancement is
// independent: if any single load fails, the viz keeps running on its
// handcrafted profiler features. Errors are logged, not thrown.
//
// Imports resolve through the import-map in index.html.
//
// Loaded:
//   Meyda  → per-frame spectralFlux / zcr / rms override (smoother than ours)
//   pitchy → YIN-based monophonic f0 for the Voice entity
//   VAD    → Silero v5 voice activity detection
//
// NOT in v7.0 (queued for v7.1):
//   - RNNoise WASM AudioWorklet (slot reserved as attachRnnoiseWorklet())
//   - YAMNet/TFJS classifier worker (will weight Brass/Synth/Pad entities)

// Wait for the main thread to bring up audio before wiring loaders in.
function _whenAudioReady(then) {
  if (window.audioReady && window.audioContext) {
    then();
  } else {
    setTimeout(() => _whenAudioReady(then), 200);
  }
}

// ─── Meyda ──────────────────────────────────────────────────────────
// Drop-in per-frame feature extractor. Wraps an analyser-like node and
// stuffs results into window.__v7Meyda.lastFeatures so profiler.js can
// override its handcrafted features.
(async () => {
  try {
    const Meyda = (await import("meyda")).default;
    _whenAudioReady(() => {
      window.__v7Meyda = window.__v7Meyda || {};
      const analyzer = Meyda.createMeydaAnalyzer({
        audioContext: window.audioContext,
        source: window.audioStreamSource,
        bufferSize: 1024,
        featureExtractors: ["rms", "zcr", "spectralFlux", "perceptualSharpness"],
        callback: features => { window.__v7Meyda.lastFeatures = features; }
      });
      analyzer.start();
      _markStatus("meyda", true);
    });
  } catch (e) {
    console.warn("[v7] meyda load failed — falling back to handcrafted features", e);
    _markStatus("meyda", false);
  }
})();

// ─── pitchy ─────────────────────────────────────────────────────────
// Monophonic pitch detection. Runs on the time-domain buffer that the
// profiler already grabs each frame. Writes voiceF0 + voicePitchClarity
// for the Voice entity detector.
(async () => {
  try {
    const pitchy = await import("pitchy");
    const PitchDetector = pitchy.PitchDetector;
    _whenAudioReady(() => {
      const detector = PitchDetector.forFloat32Array(window.audioAnalyser.fftSize);
      // Tap into the existing draw loop via a frame callback; sketch.js calls
      // window.__v7Pitch.tick() once per frame after profileFrame().
      window.__v7Pitch = {
        tick() {
          if (!window.audioTimeFloat) return;
          const [f0, clarity] = detector.findPitch(window.audioTimeFloat, window.audioContext.sampleRate);
          if (clarity > 0.5 && f0 > 60 && f0 < 1200) {
            window.voiceF0 = f0;
            window.voicePitchClarity = clarity;
          } else {
            window.voicePitchClarity *= 0.85;
            if (window.voicePitchClarity < 0.05) window.voiceF0 = 0;
          }
        }
      };
      _markStatus("pitchy", true);
    });
  } catch (e) {
    console.warn("[v7] pitchy load failed — voice falls back to band heuristic", e);
    _markStatus("pitchy", false);
  }
})();

// ─── Silero VAD ─────────────────────────────────────────────────────
// Real-time voice activity detection. The vad-web package fires onSpeechStart
// / onSpeechEnd callbacks; we flip the voiceVAD boolean for entities.js.
(async () => {
  try {
    const vadMod = await import("@ricky0123/vad-web");
    const MicVAD = vadMod.MicVAD;
    _whenAudioReady(async () => {
      const myvad = await MicVAD.new({
        onSpeechStart: () => { window.voiceVAD = true; },
        onSpeechEnd: () => { window.voiceVAD = false; },
        onVADMisfire: () => { window.voiceVAD = false; }
      });
      myvad.start();
      window.__v7VAD = myvad;
      _markStatus("vad", true);
    });
  } catch (e) {
    console.warn("[v7] vad-web load failed — voice falls back to band heuristic", e);
    _markStatus("vad", false);
  }
})();

// ─── status surface (visible in HUD) ────────────────────────────────
window.__v7LoaderStatus = window.__v7LoaderStatus || {};
function _markStatus(name, ok) {
  window.__v7LoaderStatus[name] = ok;
  const el = document.getElementById("hud-status");
  if (!el) return;
  const s = window.__v7LoaderStatus;
  const parts = Object.entries(s).map(([k, v]) => `${k}:${v ? "on" : "—"}`);
  el.textContent = "deps  " + parts.join(" · ");
}

// ─── RNNoise worklet slot ───────────────────────────────────────────
// Reserved for v7.1. The profiler's setNoiseFilter('rnnoise') path calls
// attachRnnoiseWorklet() if it exists; today it does not.
//   async function attachRnnoiseWorklet() {
//     await audioContext.audioWorklet.addModule('audio/worklet-rnnoise.js');
//     const node = new AudioWorkletNode(audioContext, 'rnnoise-processor');
//     audioStreamSource.disconnect(audioAnalyser);
//     audioStreamSource.connect(node);
//     node.connect(audioAnalyser);
//   }
