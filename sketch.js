// sketch.js — p5 setup/draw glue, camera, UI, input.
// Sits at the top of the dependency tree; everything else is loaded into
// global scope by index.html's <script> tags before this file runs.

// ─── Camera state (lifted from volumetric-led) ──────────────────────
let camRotX = -0.35;
let camRotY = 0.55;
let camZoom = 1.0;
let isDragging = false;
let lastMouse = { x: 0, y: 0 };
const ROTATE_SPEED = 0.0025;
let paused = false;
let showBandRing = true;

// ─── HUD elements ───────────────────────────────────────────────────
let hudEl, entitiesEl, startEl;
let hudVisible = false;        // hidden until audio starts, then revealed
let bandNeuronIdx = [];        // first 14 NEURONS entries (band ring)
let entityNeuronIdx = [];      // remaining entries (entity neurons)

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(Math.min(displayDensity(), 2));

  initVoxels();
  rebuildNeurons(0xC0FFEE);
  // After buildNeurons, slot indices so sketch can address band vs entity bursts.
  for (let i = 0; i < NEURONS.length; i++) {
    if (NEURONS[i].kind === "band") bandNeuronIdx.push(i);
    else entityNeuronIdx.push(i);
  }

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
    profileFrame();
    if (typeof window.__v7Pitch !== "undefined") window.__v7Pitch.tick();
    const fires = detectEntities();
    routeFires(fires);
    decayVoxels();
    for (const n of NEURONS) n.step();
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

  // ─── Render voxels ──────────────────────────────────────────────
  renderVoxels(window, !showBandRing);

  // ─── 2D HUD entity bars ─────────────────────────────────────────
  _renderEntityBars();
}

// Route per-frame entity firing levels into the matching neurons. Also drives
// the band ring from the per-band relativeEnergy so it pulses with the
// spectrum (continuity with v6's frequency-legend feel).
function routeFires(fires) {
  for (let i = 0; i < bandNeuronIdx.length; i++) {
    const n = NEURONS[bandNeuronIdx[i]];
    const r = frequencyRanges[i];
    if (!r) continue;
    // v6's relativeEnergy = 4 * energy / threshold (so it's 4 at threshold).
    // Scale ×0.18 so a band fires fully only well above threshold (~1.4×) and
    // sits in the 0.3–0.7 range during typical music. Avoids the "everything
    // is always lit" failure mode caught during red-team.
    const level = Math.min(1, (r.relativeEnergy || 0) * 0.18);
    n.fire(level);
  }
  for (const idx of entityNeuronIdx) {
    const n = NEURONS[idx];
    const lv = fires[n.name];
    if (lv != null) n.fire(lv);
  }
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
function mousePressed(e) {
  // Only the canvas drives camera. If the click started on the splash, the
  // splash handler runs and we bail.
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

function mouseReleased() {
  isDragging = false;
  return false;
}

function mouseWheel(event) {
  if (!audioReady) return;
  camZoom *= event.delta > 0 ? 0.93 : 1.07;
  camZoom = Math.max(0.4, Math.min(3.5, camZoom));
  return false;
}

function touchStarted(e) {
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

function touchEnded() {
  isDragging = false;
  return false;
}

function keyPressed() {
  if (key === 'h' || key === 'H') {
    hudVisible = !hudVisible;
    hudEl.classList.toggle("hidden", !hudVisible);
    entitiesEl.classList.toggle("hidden", !hudVisible);
  } else if (key === 'f' || key === 'F') {
    _toggleFullscreen();
  } else if (key === 'r' || key === 'R') {
    rebuildNeurons();
    bandNeuronIdx.length = 0;
    entityNeuronIdx.length = 0;
    for (let i = 0; i < NEURONS.length; i++) {
      if (NEURONS[i].kind === "band") bandNeuronIdx.push(i);
      else entityNeuronIdx.push(i);
    }
    console.log("[v7] dendrites rebuilt");
  } else if (key === 'b' || key === 'B') {
    showBandRing = !showBandRing;
  } else if (key === 'n' || key === 'N') {
    const cur = noiseFilterMode;
    const next = cur === "off" ? "native" : "off";
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
