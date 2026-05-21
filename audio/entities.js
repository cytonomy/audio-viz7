// audio/entities.js — 7 entity firing rules with adaptive noise rejection.
// Every band reading passes through `noiseGate()` first, which subtracts an
// adaptive per-band floor (asymmetric EMA — falls instantly to a new
// minimum, rises very slowly so background rumble accumulates into the
// floor and stops tripping entity detectors). Net result: in a quiet room
// the floor stays low and light bass passes through; in a noisy room
// (fans, HVAC, handling noise) the floor rises and only real transients
// clear the gate.
//
// A global silence gate also zeros all entity levels when global RMS is
// below ambient, so the viz doesn't generate phantom bursts on dead air.
//
// Honest framing: drums = confident, voice = good (better with VAD/pitchy
// loaded), brass/synth/pad = "responds when prominently present."

// Shared refractory state per detector class.
const _transientState = { lastKickAt: -999, lastSnareAt: -999 };
let _frameTick = 0;

// VAD/pitchy outputs (assigned by audio/loaders.js via window.).
var voiceVAD = false;
var voiceF0 = 0;
var voicePitchClarity = 0;

// Output bars for the HUD.
const entityFireLevels = {
  kick: 0, snare: 0, hat: 0, voice: 0, brass: 0, synth: 0, pad: 0
};

// ─── Adaptive noise floor ─────────────────────────────────────────
// Per-band-range floor map. Keyed by "minHz,maxHz" string so different
// callers querying the same band share the same floor. Updated each call.
const _floors = new Map();
const NOISE_FLOOR_FACTOR = 2.0;      // require energy ≥ floor × this to count
const MIN_FLOOR = 0.012;             // never below this — ambient mic noise
const SILENCE_RMS = 0.005;           // global silence gate
const FLOOR_RISE = 0.0006;           // very slow EMA upward → ~28 sec time constant

function noiseGate(value, key) {
  let floor = _floors.get(key);
  if (floor == null) floor = value;
  if (value < floor) floor = value;                 // descend instantly to a new minimum
  else floor = floor * (1 - FLOOR_RISE) + value * FLOOR_RISE;
  if (floor < MIN_FLOOR) floor = MIN_FLOOR;
  _floors.set(key, floor);
  const net = value - floor * NOISE_FLOOR_FACTOR;
  return net > 0 ? net : 0;
}

function _getFloor(key) {
  const f = _floors.get(key);
  return f != null ? f : 0;
}

function detectEntities() {
  _frameTick++;

  // Raw band reads
  const sub   = bandEnergy(40, 100);
  const vlow  = bandEnergy(20, 40);
  const lowM  = bandEnergy(200, 800);
  const midH  = bandEnergy(800, 4000);
  const high  = bandEnergy(6000, 14000);
  const brassBody = bandEnergy(200, 1200);
  const brassHarm = bandEnergy(800, 2400);
  const synthBody = bandEnergy(400, 3000);

  // Net (gated) reads — what's left after the adaptive noise floor
  const subN     = noiseGate(sub,       'sub');
  const lowMN    = noiseGate(lowM,      'lowM');
  const midHN    = noiseGate(midH,      'midH');
  const highN    = noiseGate(high,      'high');
  const brassBN  = noiseGate(brassBody, 'brassB');
  const brassHN  = noiseGate(brassHarm, 'brassH');
  const synthBN  = noiseGate(synthBody, 'synthB');

  // Update floors for unused-but-tracked bands too, so they don't drift.
  noiseGate(vlow, 'vlow');

  // ─── Global silence gate ──────────────────────────────────────
  if (rms < SILENCE_RMS) {
    entityFireLevels.kick = 0; entityFireLevels.snare = 0; entityFireLevels.hat = 0;
    entityFireLevels.voice = 0; entityFireLevels.brass = 0; entityFireLevels.synth = 0;
    entityFireLevels.pad = 0;
    return entityFireLevels;
  }

  // ─── Kick ─────────────────────────────────────────────────────
  // Requires BOTH a strong net sub spike AND a clear spectral-flux transient.
  // Dropped the sustained-sub fallback that previously fired on any moderate
  // bass — that was the noise-sensitivity bug.
  let kick = 0;
  if (_frameTick - _transientState.lastKickAt > 6) {
    const transient = Math.max(0, spectralFlux - 0.22);
    if (subN > 0.08 && transient > 0.04) {
      kick = Math.min(1, subN * 2.5 + transient * 1.5);
      if (kick > 0.4) _transientState.lastKickAt = _frameTick;
    }
  }

  // ─── Snare ────────────────────────────────────────────────────
  // Broadband transient with noisy time-domain signature (high ZCR).
  let snare = 0;
  if (_frameTick - _transientState.lastSnareAt > 5) {
    const body = lowMN + midHN * 0.8;
    const noisy = zcr > 0.08 ? 1 : zcr / 0.08;
    const transient = Math.max(0, spectralFlux - 0.22);
    if (body > 0.08 && transient > 0.05 && noisy > 0.55) {
      snare = Math.min(1, body * 1.4 + transient * 1.8 * noisy);
      if (snare > 0.35) _transientState.lastSnareAt = _frameTick;
    }
  }

  // ─── Hat ──────────────────────────────────────────────────────
  // High-band transient + high ZCR. Hats roll fast, no refractory.
  let hat = 0;
  if (highN > 0.025 && zcr > 0.12) {
    const hatTransient = Math.max(0, spectralFlux - 0.08);
    hat = Math.min(1, highN * 2.2 + hatTransient * 1.2);
  }

  // ─── Voice ────────────────────────────────────────────────────
  // Best signal: VAD + pitchy. Fallback: gated mid-band + low flux + voice-
  // range ZCR. Both paths capped harder than the v7.3 version — voice was
  // also firing on ambient.
  let voice = 0;
  if (voiceVAD && voiceF0 > 80 && voiceF0 < 500 && voicePitchClarity > 0.6) {
    voice = Math.min(1, 0.45 + voicePitchClarity * 0.55);
  } else {
    const vbody = lowMN * 1.5 + midHN * 0.4;
    const sustainBonus = 1 - Math.min(1, spectralFlux * 3);
    if (vbody > 0.12 && zcr > 0.04 && zcr < 0.16) {
      voice = Math.min(0.55, vbody * sustainBonus * 0.95);
    }
  }

  // ─── Brass ────────────────────────────────────────────────────
  // Harmonic stack 200-1200 + 800-2400, sustained (low flux), with little sub.
  let brass = 0;
  if (brassBN > 0.10 && brassHN > 0.08 && sub < brassBody * 0.7) {
    const sustainBonus = 1 - Math.min(1, spectralFlux * 2);
    brass = Math.min(0.7, (brassBN + brassHN) * 0.8 * sustainBonus);
  }

  // ─── Synth ────────────────────────────────────────────────────
  let synth = 0;
  if (synthBN > 0.10 && spectralFlux < 0.15) {
    synth = Math.min(0.7, synthBN * 1.6 * (1 - spectralFlux * 2.5));
  }

  // ─── Pad ──────────────────────────────────────────────────────
  let pad = 0;
  const padBody = (lowMN + midHN) * 0.5;
  if (padBody > 0.08 && spectralFlux < 0.08 && volumeEnvelope > 0.05) {
    pad = Math.min(0.55, padBody * 1.6 * (1 - spectralFlux * 4));
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

// Debug helper — sketch.js can show the current floors in the HUD.
function getFloorSnapshot() {
  return {
    sub: _getFloor('sub').toFixed(3),
    lowM: _getFloor('lowM').toFixed(3),
    midH: _getFloor('midH').toFixed(3),
    high: _getFloor('high').toFixed(3)
  };
}
