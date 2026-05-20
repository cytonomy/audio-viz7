// audio/entities.js — 7 entity firing rules.
// Each entity reads from the per-frame profiler outputs (bandEnergy + flux +
// rms + zcr + pitchy f0 if loaded + VAD state if loaded) and returns a 0..1
// "fire level". sketch.js routes that into the matching entity neuron.
//
// Honest framing: this is heuristic source-attribution, not separation.
// Drums = confident (frequency-localized + transient-localized).
// Voice  = good (VAD + pitch range).
// Brass / Synth / Pad = "responds when prominently present" — they'll false
// fire on similar-spectrum content. That's the budget; reframe if asked.

// Shared transient gate state — kick + snare share a coarse refractory so
// they don't both fire on the same broadband click.
const _transientState = { lastKickAt: -999, lastSnareAt: -999 };
let _frameTick = 0;

// Pitchy / VAD outputs (populated by audio/loaders.js if those load).
// `var` so the ES-module loader can write through `window.voiceVAD = ...`.
var voiceVAD = false;          // true when Silero VAD is reporting speech
var voiceF0 = 0;               // Hz, monophonic estimate, 0 if no clear pitch
var voicePitchClarity = 0;     // 0..1 confidence of the f0

// Last computed firing levels — exposed for the HUD bar display.
const entityFireLevels = {
  kick: 0, snare: 0, hat: 0, voice: 0, brass: 0, synth: 0, pad: 0
};

function detectEntities() {
  _frameTick++;
  const sub  = bandEnergy(40, 100);                           // kick body
  const lowM = bandEnergy(200, 800);                          // snare/voice body
  const midH = bandEnergy(800, 4000);                         // snare crack / voice formants
  const high = bandEnergy(6000, 14000);                       // hat shimmer
  const vlow = bandEnergy(20, 40);                            // sub rumble

  // ─── Kick ─────────────────────────────────────────────────────────
  // Strong sub-band RMS coinciding with a spectral-flux spike. Refractory
  // 6 frames so a single kick doesn't fire 10× in a row.
  let kick = 0;
  if (_frameTick - _transientState.lastKickAt > 6) {
    const kickRaw = sub * 1.4 + vlow * 0.6;
    const transient = Math.max(0, spectralFlux - 0.15);
    if (kickRaw > 0.25 && transient > 0.02) {
      kick = Math.min(1, kickRaw * 1.2 + transient * 1.5);
      if (kick > 0.4) _transientState.lastKickAt = _frameTick;
    } else if (kickRaw > 0.18) {
      // Sustained sub energy without transient — quiet glow, no burst.
      kick = kickRaw * 0.5;
    }
  }

  // ─── Snare ────────────────────────────────────────────────────────
  // Broadband transient (lowM + midH together) with a sharpness spike from
  // ZCR > ~0.08 — snares are noisy in the time domain.
  let snare = 0;
  if (_frameTick - _transientState.lastSnareAt > 5) {
    const body = lowM + midH * 0.8;
    const noisy = zcr > 0.07 ? 1 : zcr / 0.07;
    const transient = Math.max(0, spectralFlux - 0.18);
    if (body > 0.18 && transient > 0.03 && noisy > 0.5) {
      snare = Math.min(1, body * 0.9 + transient * 1.8 * noisy);
      if (snare > 0.35) _transientState.lastSnareAt = _frameTick;
    }
  }

  // ─── Hat ──────────────────────────────────────────────────────────
  // High-band transient with very high ZCR. No refractory — hats often roll.
  let hat = 0;
  const hatTransient = Math.max(0, spectralFlux - 0.05);
  if (high > 0.05 && zcr > 0.1) {
    hat = Math.min(1, high * 1.5 + hatTransient * 1.2);
  }

  // ─── Voice ────────────────────────────────────────────────────────
  // Best signal: Silero VAD says speech AND pitchy gives a confident f0 in
  // human range. Fallback heuristic: mid-low band energy + low flux (voice
  // is more sustained than percussive) + moderate ZCR.
  let voice = 0;
  if (voiceVAD && voiceF0 > 80 && voiceF0 < 500 && voicePitchClarity > 0.6) {
    voice = Math.min(1, 0.5 + voicePitchClarity * 0.5);
  } else {
    const vbody = lowM * 1.2 + midH * 0.4;
    const sustainBonus = 1 - Math.min(1, spectralFlux * 3);   // less flux = more voice-like
    if (vbody > 0.25 && zcr > 0.04 && zcr < 0.16) {
      voice = Math.min(0.65, vbody * sustainBonus * 0.9);     // cap heuristic-only voice
    }
  }

  // ─── Brass ────────────────────────────────────────────────────────
  // Harmonic stack in 200–1200 Hz: ratio of [200,1200] energy to [40,100]
  // (brass has rich mids without much sub). Sustained = low flux. The
  // "trumpet hit" is when this lights up *with* energy in the 800–2400
  // range from the harmonic series.
  let brass = 0;
  const brassBody = bandEnergy(200, 1200);
  const brassHarm = bandEnergy(800, 2400);
  if (brassBody > 0.22 && brassHarm > 0.16 && sub < brassBody * 0.7) {
    const sustainBonus = 1 - Math.min(1, spectralFlux * 2);
    brass = Math.min(0.7, (brassBody + brassHarm) * 0.5 * sustainBonus);
  }

  // ─── Synth ────────────────────────────────────────────────────────
  // Sustained mid energy with very low flux — synth pads / leads hold notes.
  let synth = 0;
  const synthBody = bandEnergy(400, 3000);
  if (synthBody > 0.2 && spectralFlux < 0.15) {
    synth = Math.min(0.7, synthBody * 1.1 * (1 - spectralFlux * 2.5));
  }

  // ─── Pad ──────────────────────────────────────────────────────────
  // Very low flux, broad mid-band sustain, low transient. The "atmospheric"
  // entity — wash of strings, ambient texture.
  let pad = 0;
  const padBody = (lowM + midH) * 0.5;
  if (padBody > 0.18 && spectralFlux < 0.08 && volumeEnvelope > 0.05) {
    pad = Math.min(0.6, padBody * 1.2 * (1 - spectralFlux * 4));
  }

  entityFireLevels.kick = kick;
  entityFireLevels.snare = snare;
  entityFireLevels.hat = hat;
  entityFireLevels.voice = voice;
  entityFireLevels.brass = brass;
  entityFireLevels.synth = synth;
  entityFireLevels.pad = pad;
  return entityFireLevels;
}
