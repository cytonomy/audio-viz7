// sketch.js — p5 setup/draw glue, camera, UI, input.
// Sits at the top of the dependency tree; everything else is loaded into
// global scope by index.html's <script> tags before this file runs.
//
// Visual model: ephemeral bursts (see visual/bursts.js). Per frame we run
// the audio profiler + entity detectors, then check threshold-cross + per-
// source refractory per band/entity. Each cross spawns a fresh Burst at a
// jittered position around the source's "home region" in the cube. Bursts
// walk their own dendrite tree, propagate an AP, fade, and self-cull.

// ─── Camera state (lifted from volumetric-led) ──────────────────────
let camRotX = -0.35;
let camRotY = 0.55;
let camZoom = 1.0;
let isDragging = false;
let lastMouse = { x: 0, y: 0 };
const ROTATE_SPEED = 0.0025;
let paused = false;
let mutebands = false;     // B-key toggles to silence band bursts (entity-only)

// ─── HUD elements ───────────────────────────────────────────────────
let hudEl, entitiesEl, startEl;
let hudVisible = false;

// ─── Per-source spawn state ─────────────────────────────────────────
// Edge-cross + refractory per band, with energy ACCUMULATION between bursts.
// Each frame we add the band's relativeEnergy into bandEnergyAccum[i].
// When the band crosses SPAWN_LEVEL and refractory is clear, we fire with
// intensity = saturating function of the accumulator, then reset it.
// Net effect: a brief loud band fires a small burst; sustained loud bands
// fire larger bursts ("batched/aggregated signal"). Sustain re-fire disabled
// (set to a very large number) so every burst feels like a discrete event.
const BAND_SPAWN_LEVEL = 1.2;        // (relativeEnergy units; 1.0 = at threshold)
const BAND_REFRACTORY = 36;          // 3× prior — slow cadence per band
const BAND_SUSTAIN_INTERVAL = 9999;  // disabled — no sustain re-fires
const BAND_ACCUM_SAT = 24;           // accumulator (units of above-threshold re·frames) → intensity 1.0
const bandLastSpawn = new Array(14).fill(-999);
const bandWasAbove = new Array(14).fill(false);
const bandEnergyAccum = new Array(14).fill(0);

const ENTITY_SPAWN_LEVEL = 0.55;     // raised — entity needs decisive trigger
const ENTITY_REFRACTORY = {          // 3× prior values — slower cadence
  kick: 21, snare: 18, hat: 12, voice: 30, brass: 36, synth: 54, pad: 90
};
const ENTITY_ACCUM_SAT = 2;          // accumulator (units of above-threshold lv·frames) → intensity 1.0
const entityLastSpawn = {
  kick: -999, snare: -999, hat: -999, voice: -999, brass: -999, synth: -999, pad: -999
};
const entityEnergyAccum = {
  kick: 0, snare: 0, hat: 0, voice: 0, brass: 0, synth: 0, pad: 0
};
let frameTickV7 = 0;                 // local frame counter independent of p5's

// Entity spawn home positions, expressed as FRACTIONS of grid half-extent so
// the layout scales with resolution. Multiplied by VOXEL_GRID/2 at spawn.
// Each spawn jitters by ~12% of the grid so two kicks never land on the same
// voxel — keeps visual variety without losing "kick lives down here" identity.
const entityHomes = {
  kick:  { x:  0.0, y:  0.4, z:  0.0 },
  snare: { x:  0.4, y:  0.15, z:  0.0 },
  hat:   { x:  0.0, y: -0.4, z:  0.4 },
  voice: { x:  0.0, y:  0.0, z: -0.4 },
  brass: { x: -0.4, y:  0.0, z:  0.3 },
  synth: { x:  0.3, y: -0.15, z: -0.3 },
  pad:   { x: -0.3, y: -0.25, z: -0.15 }
};
const BURST_JITTER_FRAC = 0.28;     // fraction of grid half-extent — visible spread

// Global silence gate: blocks burst spawning when room is below this RMS.
// Prevents mic-on / no-audio ambient (HVAC, keyboard, fan) from crossing per-
// band thresholds and firing false bursts. Entities already have their own
// SILENCE_RMS gate in entities.js (0.005); this is a redundant outer guard
// applied uniformly to bands + entities.
const SILENCE_GATE_RMS = 0.012;

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(Math.min(displayDensity(), 2));
  initVoxels();

  hudEl = document.getElementById("hud");
  entitiesEl = document.getElementById("entities");
  startEl = document.getElementById("start");
  startEl.addEventListener("click", _onStartTap, { once: false });
  startEl.addEventListener("touchstart", _onStartTap, { once: false, passive: false });

  noFill();
  perspective(PI / 3, width / height, 1, 5000);
}

function draw() {
  background(RENDER_BG[0], RENDER_BG[1], RENDER_BG[2]);

  if (!paused) {
    frameTickV7++;
    profileFrame();
    if (typeof window.__v7Pitch !== "undefined") window.__v7Pitch.tick();
    const fires = detectEntities();
    spawnFromBands();
    spawnFromEntities(fires);
    decayVoxels();
    stepBursts();
  }

  // ─── Camera ─────────────────────────────────────────────────────
  const totalSize = VOXEL_GRID * VOXEL_SPACING;
  // Camera distance multiplier — lower = closer = cube fills more viewport.
  const camDist = totalSize * 0.55 / camZoom;
  if (!isDragging && !paused) camRotY += ROTATE_SPEED;
  const cosX = Math.cos(camRotX), sinX = Math.sin(camRotX);
  const camX = camDist * Math.sin(camRotY) * cosX;
  const camY = camDist * sinX;
  const camZ = camDist * Math.cos(camRotY) * cosX;
  camera(camX, camY, camZ, 0, 0, 0, 0, 1, 0);

  renderVoxels(window, false);
  _renderEntityBars();
}

// ─── Band burst spawning ────────────────────────────────────────────
// For each band: accumulate relativeEnergy every frame; on threshold-cross
// (rising edge, refractory clear) fire with intensity = accumulator / SAT,
// then reset accumulator. Color is the global radial palette — no band hue.
function spawnFromBands() {
  if (mutebands) return;
  if (rms < SILENCE_GATE_RMS) {
    // Below silence floor — also drain accumulators so a long quiet pause
    // doesn't leave residual energy that pops on the first real signal.
    for (let i = 0; i < bandEnergyAccum.length; i++) bandEnergyAccum[i] = 0;
    return;
  }
  for (let i = 0; i < frequencyRanges.length; i++) {
    const r = frequencyRanges[i];
    const re = r.relativeEnergy || 0;
    const above = re > BAND_SPAWN_LEVEL;
    // Only accumulate ABOVE-threshold energy — ambient quiet bands don't pool.
    if (above) bandEnergyAccum[i] += (re - BAND_SPAWN_LEVEL);
    const sinceLast = frameTickV7 - bandLastSpawn[i];
    const isRisingEdge = above && !bandWasAbove[i] && sinceLast > BAND_REFRACTORY;
    const isSustainTick = above && bandWasAbove[i] && sinceLast > BAND_SUSTAIN_INTERVAL;
    if (isRisingEdge || isSustainTick) {
      // Hybrid intensity: max of (current spike loudness) and (accumulated
      // above-threshold energy). Single sharp transients still register;
      // sustained loud periods get the accumulation bonus.
      const peakIntensity = Math.min(1, (re - BAND_SPAWN_LEVEL) / 2.5);
      const accumIntensity = Math.min(1, bandEnergyAccum[i] / BAND_ACCUM_SAT);
      const intensity = Math.max(peakIntensity, accumIntensity);
      _spawnBandBurst(i, intensity);
      bandLastSpawn[i] = frameTickV7;
      bandEnergyAccum[i] = 0;
    }
    bandWasAbove[i] = above;
  }
}

// All tree lengths scale with grid resolution so the visual density of a
// burst stays consistent regardless of how many LEDs the cube has.
const _GRID_TREE_SCALE = VOXEL_GRID / 16;       // 1 at GRID=16, 2 at GRID=32

// Band bursts spawn from cube center (±small jitter) — they're the
// "background spectrum chatter" layer, deliberately overlapping at the
// core so they don't compete with the entity bursts visually.
const CENTER_JITTER = 1.5;
function _centerSoma() {
  const cx = (VOXEL_GRID - 1) / 2;
  const cy = (VOXEL_GRID - 1) / 2;
  const cz = (VOXEL_GRID - 1) / 2;
  return {
    x: _clamp(Math.round(cx + (Math.random() - 0.5) * CENTER_JITTER * 2)),
    y: _clamp(Math.round(cy + (Math.random() - 0.5) * CENTER_JITTER * 2)),
    z: _clamp(Math.round(cz + (Math.random() - 0.5) * CENTER_JITTER * 2))
  };
}

// Entity bursts spawn at a random position within the entity's "zone" —
// each instrument gets its own neighborhood of the cube (kick low, hat
// high, voice back, brass left, etc.) with WIDE jitter so each new burst
// of the same instrument hops to a different spot within its zone. The
// visual effect: each instrument looks like a separate moving cluster.
const ENTITY_ZONE_JITTER_FRAC = 0.50;     // ±50% of grid half-extent
function _entityZoneSoma(name) {
  const h = entityHomes[name];
  if (!h) return _centerSoma();
  const half = VOXEL_GRID / 2;
  const cx = (VOXEL_GRID - 1) / 2;
  const cy = (VOXEL_GRID - 1) / 2;
  const cz = (VOXEL_GRID - 1) / 2;
  const jit = half * ENTITY_ZONE_JITTER_FRAC;
  return {
    x: _clamp(Math.round(cx + h.x * half + (Math.random() - 0.5) * jit * 2)),
    y: _clamp(Math.round(cy + h.y * half + (Math.random() - 0.5) * jit * 2)),
    z: _clamp(Math.round(cz + h.z * half + (Math.random() - 0.5) * jit * 2))
  };
}

// Pitch-modulated voice palette. When pitchy reports a confident f0, build
// a 5-stop gradient around an f0-derived base hue (low pitch = warm yellow,
// high pitch = cool magenta). Falls back to null when no pitch is available
// → Burst then uses the default static voice palette.
function _voicePaletteForPitch() {
  const f0 = (typeof window.voiceF0 === 'number') ? window.voiceF0 : voiceF0;
  const clarity = (typeof window.voicePitchClarity === 'number') ? window.voicePitchClarity : voicePitchClarity;
  if (!f0 || f0 < 80 || !clarity || clarity < 0.5) return null;
  // 80-500 Hz → hue 60° (yellow) to 300° (magenta).
  const t = Math.min(1, Math.max(0, (f0 - 80) / 420));
  const baseHue = 60 + t * 240;
  // Synthesize 5 stops sweeping lightness around the base hue, with the
  // outer stops slightly shifted toward complementary so the gradient
  // reads as a colored corona rather than a single hue everywhere.
  return [
    hslToRgb(baseHue + 30, 80, 22),
    hslToRgb(baseHue + 12, 85, 40),
    hslToRgb(baseHue,      90, 60),
    hslToRgb(baseHue - 22, 78, 76),
    hslToRgb(baseHue - 45, 65, 88)
  ];
}

function _spawnBandBurst(bandIdx, intensity) {
  const r = frequencyRanges[bandIdx];
  const baseNodes = r.group === "bass" ? 130 : r.group === "high" ? 70 : 100;
  spawnBurst(
    _centerSoma(),
    r.rgb,
    r.rgb,
    {
      kind: "band",
      label: r.name,
      intensity,
      paletteKey: "band",
      lifespan: r.group === "bass" ? 195 : r.group === "high" ? 100 : 145,  // ↑ ~1.7× — bursts persist longer
      apFrames: r.group === "bass" ? 81 : r.group === "high" ? 42 : 54,     // ↑ ~1.5× more — AP wave reveals tree slower
      targetNodes: Math.round(baseNodes * _GRID_TREE_SCALE * (0.6 + intensity * 1.2))
    }
  );
}

// ─── Entity burst spawning ──────────────────────────────────────────
// Accumulate per-entity fire level every frame; on threshold-cross + refractory
// clear, fire with intensity = accumulator / SAT. Bigger accumulator → bigger
// burst. Reset after spawn.
function spawnFromEntities(fires) {
  if (rms < SILENCE_GATE_RMS) {
    for (const name in entityEnergyAccum) entityEnergyAccum[name] = 0;
    return;
  }
  for (const name in entityHomes) {
    const lv = fires[name] || 0;
    // Only accumulate above-threshold contributions so ambient noise doesn't pool.
    if (lv > ENTITY_SPAWN_LEVEL) entityEnergyAccum[name] += (lv - ENTITY_SPAWN_LEVEL);
    if (lv < ENTITY_SPAWN_LEVEL) continue;
    if (frameTickV7 - entityLastSpawn[name] < ENTITY_REFRACTORY[name]) continue;
    // Hybrid intensity (see spawnFromBands): max of current spike and accumulator.
    const peakIntensity = Math.min(1, (lv - ENTITY_SPAWN_LEVEL) / 0.4);
    const accumIntensity = Math.min(1, entityEnergyAccum[name] / ENTITY_ACCUM_SAT);
    const intensity = Math.max(peakIntensity, accumIntensity);
    _spawnEntityBurst(name, intensity);
    entityLastSpawn[name] = frameTickV7;
    entityEnergyAccum[name] = 0;
  }
}

function _spawnEntityBurst(name, intensity) {
  const somaColor = entityPalette[name];
  // Per-entity tuning: kick is slow + chunky, hat is fast + thin, etc.
  // targetNodes scales with intensity so accumulated bursts grow up to 2.4×.
  // Lifespan bumped ~1.7× and apFrames bumped ~1.5× — bursts persist longer
  // and the AP wavefront reveals each tree more gradually. Trees feel like
  // they unfold rather than snap into shape, and stay visible long enough to
  // build up overlapping layers across the larger cube.
  const profiles = {
    kick:  { lifespan: 170, apFrames: 72,  nodes: 130 },
    snare: { lifespan: 120, apFrames: 50,  nodes: 95  },
    hat:   { lifespan: 75,  apFrames: 33,  nodes: 70  },
    voice: { lifespan: 150, apFrames: 68,  nodes: 110 },
    brass: { lifespan: 170, apFrames: 81,  nodes: 120 },
    synth: { lifespan: 200, apFrames: 90,  nodes: 130 },
    pad:   { lifespan: 250, apFrames: 108, nodes: 140 }
  };
  const prof = profiles[name];
  // Voice gets a pitch-modulated palette if pitchy is loaded + confident.
  const dynamicPalette = name === 'voice' ? _voicePaletteForPitch() : null;
  spawnBurst(_entityZoneSoma(name), somaColor, somaColor, {
    kind: "entity",
    label: name,
    intensity,
    paletteKey: name,
    dynamicPalette,
    lifespan: prof.lifespan,
    apFrames: prof.apFrames,
    targetNodes: Math.round(prof.nodes * _GRID_TREE_SCALE * (0.6 + intensity * 1.2))
  });
}

function _clamp(v) {
  return Math.max(1, Math.min(VOXEL_GRID - 2, v));
}

function _renderEntityBars() {
  if (!entitiesEl || !audioReady) return;
  const names = ["kick", "snare", "hat", "voice", "brass", "synth", "pad"];
  const lines = names.map(n => {
    const v = entityFireLevels[n] || 0;
    const bars = Math.round(v * 12);
    const lit = "█".repeat(bars);
    const dim = "·".repeat(12 - bars);
    return `<div><span class="name">${n.toUpperCase()}</span> <span class="lit">${lit}</span><span class="bar">${dim}</span></div>`;
  });
  const litCount = typeof renderLitCount === "function" ? renderLitCount() : 0;
  lines.push(`<div style="margin-top:6px;color:#444;">bursts ${BURSTS.length}/${BURST_CAP} · lit ${litCount}/${MAX_RENDER_VOXELS}</div>`);
  entitiesEl.innerHTML = lines.join("");
}

// ─── Audio start handshake ──────────────────────────────────────────
function _onStartTap(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (audioReady) return;
  initAudio()
    .then(() => {
      startEl.classList.add("hidden");
      hudEl.classList.remove("hidden");
      entitiesEl.classList.remove("hidden");
      hudVisible = true;
      console.log("[v7] audio initialized · sample rate", audioContext.sampleRate);
    })
    .catch(err => {
      console.error("[v7] mic init failed", err);
      startEl.innerHTML = `<h1 style="color:#f44">mic permission denied</h1><p>refresh and try again, or check browser site settings</p>`;
    });
}

// ─── Camera input ───────────────────────────────────────────────────
function mousePressed() {
  if (!audioReady) return false;
  isDragging = true;
  lastMouse.x = mouseX;
  lastMouse.y = mouseY;
  return false;
}

function mouseDragged() {
  if (!isDragging) return false;
  const dx = mouseX - lastMouse.x;
  const dy = mouseY - lastMouse.y;
  camRotY -= dx * 0.006;
  camRotX -= dy * 0.006;
  camRotX = Math.max(-Math.PI / 2 * 0.95, Math.min(Math.PI / 2 * 0.95, camRotX));
  lastMouse.x = mouseX;
  lastMouse.y = mouseY;
  return false;
}

function mouseReleased() { isDragging = false; return false; }

function mouseWheel(event) {
  if (!audioReady) return;
  camZoom *= event.delta > 0 ? 0.93 : 1.07;
  camZoom = Math.max(0.4, Math.min(3.5, camZoom));
  return false;
}

function touchStarted() {
  if (!audioReady) return false;
  if (touches && touches.length) {
    isDragging = true;
    lastMouse.x = touches[0].x;
    lastMouse.y = touches[0].y;
  }
  return false;
}

function touchMoved() {
  if (!isDragging || !touches || !touches.length) return false;
  const dx = touches[0].x - lastMouse.x;
  const dy = touches[0].y - lastMouse.y;
  camRotY -= dx * 0.006;
  camRotX -= dy * 0.006;
  camRotX = Math.max(-Math.PI / 2 * 0.95, Math.min(Math.PI / 2 * 0.95, camRotX));
  lastMouse.x = touches[0].x;
  lastMouse.y = touches[0].y;
  return false;
}

function touchEnded() { isDragging = false; return false; }

function keyPressed() {
  if (key === 'h' || key === 'H') {
    hudVisible = !hudVisible;
    hudEl.classList.toggle("hidden", !hudVisible);
    entitiesEl.classList.toggle("hidden", !hudVisible);
  } else if (key === 'f' || key === 'F') {
    _toggleFullscreen();
  } else if (key === 'b' || key === 'B') {
    mutebands = !mutebands;
    console.log("[v7] band bursts:", mutebands ? "muted" : "on");
  } else if (key === 'n' || key === 'N') {
    const next = noiseFilterMode === "off" ? "native" : "off";
    setNoiseFilter(next).then(() => console.log("[v7] noise filter:", next));
  } else if (key === ' ') {
    paused = !paused;
  }
}

function _toggleFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el)
      .catch(e => console.warn("[v7] fullscreen failed", e));
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  perspective(PI / 3, width / height, 1, 5000);
}
