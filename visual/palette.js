// visual/palette.js — 14-band frequency hue wheel.
// Ported verbatim from audio-viz6/sketch.js:31-53 + 94-104.
// The HSL→RGB conversion runs once at load; particle/voxel render reads .rgb directly.

const frequencyRanges = [
  { name: "Sub Bass",   min:    20, max:    40, hue: 340, sat: 75, lit: 50, threshold: 0.12, group: "bass", weight: 0.45, alpha: 0.65 },
  { name: "Deep Bass",  min:    40, max:    80, hue: 355, sat: 80, lit: 55, threshold: 0.11, group: "bass", weight: 0.50, alpha: 0.70 },
  { name: "Bass",       min:    80, max:   160, hue:  18, sat: 85, lit: 58, threshold: 0.18, group: "bass", weight: 0.60, alpha: 0.75 },
  { name: "Upper Bass", min:   160, max:   300, hue:  32, sat: 90, lit: 60, threshold: 0.18, group: "bass", weight: 0.65, alpha: 0.80 },

  { name: "Low Mids",   min:   300, max:   500, hue:  48, sat: 90, lit: 58, threshold: 0.22, group: "mid",  weight: 0.75, alpha: 0.75 },
  { name: "Mid-Low",    min:   500, max:   800, hue:  65, sat: 90, lit: 58, threshold: 0.22, group: "mid",  weight: 0.85, alpha: 0.80 },
  { name: "Mid",        min:   800, max:  1200, hue:  95, sat: 85, lit: 55, threshold: 0.22, group: "mid",  weight: 1.00, alpha: 0.85 },
  { name: "Mid-High",   min:  1200, max:  2000, hue: 135, sat: 80, lit: 55, threshold: 0.20, group: "mid",  weight: 1.10, alpha: 0.90 },
  { name: "High Mids",  min:  2000, max:  3000, hue: 165, sat: 80, lit: 55, threshold: 0.16, group: "mid",  weight: 1.15, alpha: 0.90 },

  { name: "Low Treble", min:  3000, max:  4000, hue: 190, sat: 90, lit: 58, threshold: 0.10, group: "high", weight: 1.25, alpha: 1.00 },
  { name: "Mid Treble", min:  4000, max:  6000, hue: 215, sat: 90, lit: 60, threshold: 0.09, group: "high", weight: 1.20, alpha: 0.95 },
  { name: "Presence",   min:  6000, max:  8000, hue: 240, sat: 85, lit: 62, threshold: 0.08, group: "high", weight: 1.05, alpha: 0.85 },
  { name: "Brilliance", min:  8000, max: 12000, hue: 265, sat: 80, lit: 65, threshold: 0.08, group: "high", weight: 0.95, alpha: 0.75 },
  { name: "Air",        min: 12000, max: 20000, hue: 320, sat: 85, lit: 70, threshold: 0.08, group: "high", weight: 0.90, alpha: 0.70 }
];

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}
for (const r of frequencyRanges) {
  r.rgb = hslToRgb(r.hue, r.sat, r.lit);
}

// Entity palette — distinct from the band wheel so entity neurons read as
// "named characters" against the dim spectrum backdrop. Chosen to be
// recognizable at low brightness and to color-match the source intuitively
// (kick = warm orange-red, voice = warm white, brass = brass yellow, etc.).
const entityPalette = {
  kick:  [255, 100,  60],
  snare: [255, 200, 140],
  hat:   [200, 230, 255],
  voice: [255, 240, 220],
  brass: [255, 195,  70],
  synth: [140, 100, 255],
  pad:   [120, 200, 200]
};
