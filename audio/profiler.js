// audio/profiler.js — per-frame audio feature extraction.
// Always-on path: Web Audio AnalyserNode (FFT 2048). Ports the bass/mid/high
// rollup pattern from audio-viz6/sketch.js:331-373,518-536 and adds the
// transient + spectral features the entity detectors need.
// Enriched path: Meyda (if loaded via audio/loaders.js) overrides the
// handcrafted spectralFlux / zcr / rms with library values for better
// stability — falls through to handcrafted when Meyda is unavailable.

// Globals (read by sketch.js, entities.js, render.js).
// `var` is intentional: classic-script `let` at top level is NOT exposed on
// window, which means the ES-module `audio/loaders.js` could not see them.
// `var` declarations at script top level DO become window properties, so
// the module can do `window.audioContext` and stay in sync with reassignment.
var audioContext = null;
var audioAnalyser = null;
var audioFreqByte = null;          // Uint8Array of byte-frequency data (0..255)
var audioFreqFloat = null;         // Float32Array of dB-frequency data (for spectral flux)
var audioTimeFloat = null;         // Float32Array of time-domain samples (for RMS / ZCR)
var audioReady = false;
var audioStream = null;
var audioStreamSource = null;

// Per-frame outputs (updated by profileFrame())
let bassLevel = 0, midLevel = 0, highLevel = 0;
let audioLevel = 0;
let pulseEnvelope = 0;             // bass peak-hold (v6's beat pulse)
let volumeEnvelope = 0;            // slow EMA on audioLevel — feeds renderer breath
let globalBreath = 0;              // mapped 0..1 from volumeEnvelope for render.js
let spectralFlux = 0;              // positive frame-to-frame spectral change
let zcr = 0;                       // zero-crossing rate, 0..1
let rms = 0;                       // 0..1
let lastFreqFrame = null;          // previous frame's freq for flux calc

// Native MediaTrackConstraints toggle. When the user turns on the noise
// filter via N key, we restart the stream with noiseSuppression: true.
// RNNoise via worklet plugs in here as a more aggressive filter later
// (see audio/loaders.js).
let noiseFilterMode = "native";    // "off" | "native" | "rnnoise"

async function initAudio(constraintsOverride) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    latencyHint: "interactive"
  });
  audioAnalyser = audioContext.createAnalyser();
  audioAnalyser.fftSize = 2048;
  audioAnalyser.smoothingTimeConstant = 0.5;
  audioFreqByte  = new Uint8Array(audioAnalyser.frequencyBinCount);
  audioFreqFloat = new Float32Array(audioAnalyser.frequencyBinCount);
  audioTimeFloat = new Float32Array(audioAnalyser.fftSize);
  lastFreqFrame  = new Float32Array(audioAnalyser.frequencyBinCount);
  lastFreqFrame.fill(-160);                         // start at silence floor, not 0

  const constraints = constraintsOverride || {
    audio: {
      echoCancellation: true,
      noiseSuppression: noiseFilterMode === "native",
      autoGainControl: false
    },
    video: false
  };
  audioStream = await navigator.mediaDevices.getUserMedia(constraints);
  audioStreamSource = audioContext.createMediaStreamSource(audioStream);
  audioStreamSource.connect(audioAnalyser);
  audioReady = true;
  return { audioContext, audioAnalyser, audioStream };
}

// Toggle noise filter. Tears down + rebuilds the input chain.
async function setNoiseFilter(mode) {
  if (!audioReady) { noiseFilterMode = mode; return; }
  noiseFilterMode = mode;
  // Stop existing tracks so the OS releases the mic before re-requesting.
  if (audioStream) {
    for (const t of audioStream.getTracks()) t.stop();
  }
  if (audioStreamSource) audioStreamSource.disconnect();
  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: mode === "native" || mode === "rnnoise",
      autoGainControl: false
    },
    video: false
  });
  audioStreamSource = audioContext.createMediaStreamSource(audioStream);
  audioStreamSource.connect(audioAnalyser);
  // If RNNoise loader is present + mode is "rnnoise", it will splice the
  // worklet in via attachRnnoiseWorklet(audioStreamSource, audioAnalyser).
  if (mode === "rnnoise" && typeof attachRnnoiseWorklet === "function") {
    attachRnnoiseWorklet().catch(e => console.warn("[v7] rnnoise attach failed", e));
  }
}

// Energy in a [minHz, maxHz] band, 0..1. Ported from v6 getBandEnergy.
function bandEnergy(minHz, maxHz) {
  if (!audioReady) return 0;
  const sr = audioContext.sampleRate;
  const bins = audioAnalyser.frequencyBinCount;
  const nyquist = sr / 2;
  const lo = Math.floor(minHz / nyquist * bins);
  const hi = Math.floor(maxHz / nyquist * bins);
  let sum = 0, n = 0;
  for (let i = lo; i <= hi; i++) {
    if (i >= 0 && i < bins) { sum += audioFreqByte[i]; n++; }
  }
  return n > 0 ? sum / (n * 255) : 0;
}

// Main per-frame extractor. Call once per draw().
function profileFrame() {
  if (!audioReady) return;
  audioAnalyser.getByteFrequencyData(audioFreqByte);
  audioAnalyser.getFloatFrequencyData(audioFreqFloat);
  audioAnalyser.getFloatTimeDomainData(audioTimeFloat);

  // ─── Audio level (v6 sketch.js:336) ───────────────────────────────
  let bytesSum = 0;
  for (let i = 0; i < audioFreqByte.length; i++) bytesSum += audioFreqByte[i];
  audioLevel = Math.pow(bytesSum / (audioFreqByte.length * 255), 0.7);

  // ─── Per-band + bass/mid/high rollup (v6 analyzeAudio) ────────────
  let bassSum = 0, midSum = 0, highSum = 0;
  let bassN = 0,   midN = 0,   highN = 0;
  for (const r of frequencyRanges) {
    const e = bandEnergy(r.min, r.max);
    r.currentEnergy = e;
    r.relativeEnergy = 4 * e / r.threshold;
    r.isActive = e > r.threshold;
    if (r.group === "bass") { bassSum += e; bassN++; }
    else if (r.group === "mid")  { midSum += e; midN++; }
    else                          { highSum += e; highN++; }
  }
  bassLevel = bassN ? bassSum / bassN : 0;
  midLevel  = midN  ? midSum  / midN  : 0;
  highLevel = highN ? highSum / highN : 0;

  // Beat pulse: v6's bass peak-hold envelope.
  pulseEnvelope = Math.max(pulseEnvelope * 0.92, bassLevel);
  // Volume envelope (slow EMA) → render.js uses globalBreath = sqrt scaled.
  volumeEnvelope = volumeEnvelope * 0.95 + Math.max(0, audioLevel) * 0.05;
  globalBreath = Math.min(1, Math.sqrt(volumeEnvelope) * 1.6);

  // ─── Spectral flux (positive change in freq dB frame-to-frame) ───
  // Used by Kick / Snare / Hat detectors as their transient signal.
  // getFloatFrequencyData returns -Infinity for silent bins; floor to -160 so
  // a previously-silent bin lighting up doesn't spike flux to Infinity (caught
  // during red-team).
  let flux = 0;
  for (let i = 0; i < audioFreqFloat.length; i++) {
    let cur = audioFreqFloat[i];
    if (!isFinite(cur) || cur < -160) cur = -160;
    const d = cur - lastFreqFrame[i];
    if (d > 0) flux += d;
    lastFreqFrame[i] = cur;
  }
  // Normalize roughly into 0..1 — empirical, may need tuning.
  spectralFlux = Math.min(1, flux / 4000);

  // ─── RMS (time-domain) ───────────────────────────────────────────
  let sq = 0;
  for (let i = 0; i < audioTimeFloat.length; i++) sq += audioTimeFloat[i] * audioTimeFloat[i];
  rms = Math.sqrt(sq / audioTimeFloat.length);

  // ─── ZCR ─────────────────────────────────────────────────────────
  let zc = 0;
  for (let i = 1; i < audioTimeFloat.length; i++) {
    if ((audioTimeFloat[i - 1] >= 0) !== (audioTimeFloat[i] >= 0)) zc++;
  }
  zcr = zc / audioTimeFloat.length;

  // Optional Meyda override — see audio/loaders.js. If Meyda's per-frame
  // features are present, prefer them (smoothed / more stable).
  if (typeof window.__v7Meyda !== "undefined" && window.__v7Meyda.lastFeatures) {
    const f = window.__v7Meyda.lastFeatures;
    if (typeof f.rms === "number") rms = f.rms;
    if (typeof f.zcr === "number") zcr = f.zcr / audioAnalyser.fftSize;
    if (typeof f.spectralFlux === "number") spectralFlux = Math.min(1, f.spectralFlux);
  }
}
