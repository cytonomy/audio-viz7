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
// Edge-cross + refractory per band. Bursts spawn when a band's
// relativeEnergy crosses the SPAWN_LEVEL and the band's refractory has
// expired. While energy stays above SPAWN_LEVEL, re-spawn every
// SUSTAIN_INTERVAL frames so sustained loud bands keep firing.
const BAND_SPAWN_LEVEL = 1.2;        // (relativeEnergy units; 1.0 = at threshold)
const BAND_REFRACTORY = 8;           // frames between bursts per band
const BAND_SUSTAIN_INTERVAL = 14;    // re-spawn cadence on held energy
const bandLastSpawn = new Array(14).fill(-999);
const bandWasAbove = new Array(14).fill(false);

const ENTITY_SPAWN_LEVEL = 0.32;     // 0..1 in entityFireLevels space
const ENTITY_REFRACTORY = {          // frames between bursts per entity
  kick: 7, snare: 6, hat: 4, voice: 10, brass: 12, synth: 18, pad: 30
};
const entityLastSpawn = {
  kick: -999, snare: -999, hat: -999, voice: -999, brass: -999, synth: -999, pad: -999
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
const BURST_JITTER_FRAC = 0.12;     // fraction of grid half-extent

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
  const camDist = totalSize * 1.5 / camZoom;
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
// For each band, fire a burst on threshold-cross (rising edge) and re-fire
// periodically while sustained. Burst color = band's v6 hue; secondary =
// the neighboring band's hue (color diffusion follows v6's color wheel).
function spawnFromBands() {
  if (mutebands) return;
  for (let i = 0; i < frequencyRanges.length; i++) {
    const r = frequencyRanges[i];
    const re = r.relativeEnergy || 0;
    const above = re > BAND_SPAWN_LEVEL;
    const sinceLast = frameTickV7 - bandLastSpawn[i];
    const isRisingEdge = above && !bandWasAbove[i] && sinceLast > BAND_REFRACTORY;
    const isSustainTick = above && bandWasAbove[i] && sinceLast > BAND_SUSTAIN_INTERVAL;
    if (isRisingEdge || isSustainTick) {
      const intensity = Math.min(1, re / 3.5);   // re ~3.5 → full intensity
      _spawnBandBurst(i, intensity);
      bandLastSpawn[i] = frameTickV7;
    }
    bandWasAbove[i] = above;
  }
}

// All tree lengths scale with grid resolution so the visual density of a
// burst stays consistent regardless of how many LEDs the cube has.
const _GRID_TREE_SCALE = VOXEL_GRID / 16;       // 1 at GRID=16, 2 at GRID=32

function _spawnBandBurst(bandIdx, intensity) {
  const r = frequencyRanges[bandIdx];
  const neighbor = frequencyRanges[(bandIdx + 1) % frequencyRanges.length];
  const cx = (VOXEL_GRID - 1) / 2;
  const cy = (VOXEL_GRID - 1) / 2;
  const cz = (VOXEL_GRID - 1) / 2;
  // Soma position: on a ring at angle = bandIdx / 14 * 2π. Radius randomized
  // ±20% so each band-burst lands somewhere new on its arc.
  const angle = (bandIdx / frequencyRanges.length) * Math.PI * 2
              + (Math.random() - 0.5) * 0.35;
  const baseR = (VOXEL_GRID / 2 - 2);
  const radius = baseR * (0.55 + Math.random() * 0.4);
  // Vertical stratification by group (bass low, mid mid, high high) +
  // jitter per spawn. Jitter scales with grid so it stays "a bit fuzzy"
  // not "exact same row" at high resolution.
  const yJ = Math.max(2, Math.round(VOXEL_GRID * 0.12));
  const yOffset = r.group === "bass" ? Math.round(VOXEL_GRID * 0.18)
                : r.group === "high" ? -Math.round(VOXEL_GRID * 0.18) : 0;
  const sx = _clamp(Math.round(cx + Math.cos(angle) * radius));
  const sy = _clamp(Math.round(cy + yOffset + (Math.random() - 0.5) * yJ));
  const sz = _clamp(Math.round(cz + Math.sin(angle) * radius));
  spawnBurst(
    { x: sx, y: sy, z: sz },
    r.rgb,
    neighbor.rgb,
    {
      kind: "band",
      label: r.name,
      intensity,
      lifespan: r.group === "bass" ? 110 : r.group === "high" ? 55 : 80,
      apFrames: r.group === "bass" ? 26 : r.group === "high" ? 14 : 18,
      treeLen: Math.round((r.group === "bass" ? 110 : r.group === "high" ? 60 : 85) * _GRID_TREE_SCALE)
    }
  );
}

// ─── Entity burst spawning ──────────────────────────────────────────
function spawnFromEntities(fires) {
  for (const name in entityHomes) {
    const lv = fires[name] || 0;
    if (lv < ENTITY_SPAWN_LEVEL) continue;
    if (frameTickV7 - entityLastSpawn[name] < ENTITY_REFRACTORY[name]) continue;
    _spawnEntityBurst(name, lv);
    entityLastSpawn[name] = frameTickV7;
  }
}

function _spawnEntityBurst(name, intensity) {
  const h = entityHomes[name];
  const half = VOXEL_GRID / 2;
  const cx = (VOXEL_GRID - 1) / 2;
  const cy = (VOXEL_GRID - 1) / 2;
  const cz = (VOXEL_GRID - 1) / 2;
  const jit = half * BURST_JITTER_FRAC;
  const sx = _clamp(Math.round(cx + h.x * half + (Math.random() - 0.5) * jit * 2));
  const sy = _clamp(Math.round(cy + h.y * half + (Math.random() - 0.5) * jit * 2));
  const sz = _clamp(Math.round(cz + h.z * half + (Math.random() - 0.5) * jit * 2));
  const soma = entityPalette[name];
  // Pick a v6 palette color as the secondary — random per spawn so each
  // burst's diffusion picks a different neighbor hue. Gives each kick (etc.)
  // a unique color signature without losing its primary identity.
  const sec = frequencyRanges[Math.floor(Math.random() * frequencyRanges.length)].rgb;
  // Per-entity tuning: kick is slow + chunky, hat is fast + thin, etc.
  // treeLen scales with _GRID_TREE_SCALE so density stays consistent.
  const profiles = {
    kick:  { lifespan: 95,  apFrames: 22, treeLen: 95 },
    snare: { lifespan: 65,  apFrames: 16, treeLen: 75 },
    hat:   { lifespan: 38,  apFrames: 10, treeLen: 50 },
    voice: { lifespan: 80,  apFrames: 24, treeLen: 90 },
    brass: { lifespan: 90,  apFrames: 28, treeLen: 100 },
    synth: { lifespan: 110, apFrames: 32, treeLen: 110 },
    pad:   { lifespan: 140, apFrames: 40, treeLen: 110 }
  };
  const prof = profiles[name];
  spawnBurst(soma, soma, sec, {
    kind: "entity",
    label: name,
    intensity,
    lifespan: prof.lifespan,
    apFrames: prof.apFrames,
    treeLen: Math.round(prof.treeLen * _GRID_TREE_SCALE)
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
