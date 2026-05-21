// visual/bursts.js — ephemeral threshold-triggered neural EXPLOSIONS.
// Each burst is a branching dendrite tree grown BFS from a soma. Action
// potential propagates outward as a spherical wavefront expanding through
// depth shells (NOT along a 1D path) — so every burst reads as a true
// radial explosion of dendrites in all directions, no two ever the same
// shape.
//
// Per-burst color diffusion (v6 aesthetic): the soma + inner shells are
// the source's primary color; outer shells lerp toward a "secondary"
// color taken from a v6 palette neighbor. So each burst reads as a
// colored core radiating into a different hue at its branch tips.

const BURSTS = [];
const BURST_CAP = 80;
// Target unique voxel count per burst. Scales with grid resolution so visual
// density stays consistent. At GRID=16 → 96 nodes; at GRID=32 → 192.
const DEFAULT_BURST_NODES = Math.max(60, Math.round(VOXEL_GRID * 6));
let burstRng = 0xB17C;

function burstRand() {
  burstRng = (burstRng * 1664525 + 1013904223) >>> 0;
  return burstRng / 0x100000000;
}

// Random unit vector on the sphere (Marsaglia rejection method).
function _randUnitVec() {
  let vx, vy, vz, len2;
  do {
    vx = burstRand() * 2 - 1;
    vy = burstRand() * 2 - 1;
    vz = burstRand() * 2 - 1;
    len2 = vx*vx + vy*vy + vz*vz;
  } while (len2 < 0.0001 || len2 > 1);
  const inv = 1 / Math.sqrt(len2);
  return { vx: vx * inv, vy: vy * inv, vz: vz * inv };
}

// Grow organic dendrite tendrils using continuous float coordinates + per-
// sub-step velocity perturbation. This is how volumetric-led mode 5 produces
// its smooth curving paths: tips have float position (x,y,z) and unit-vector
// velocity (vx,vy,vz), advance by small sub-steps, and light up whichever
// voxel they happen to be inside.  Pure rasterization in a cubic lattice.
//
// Compared to the prior axis-aligned walker:
//   - directions are arbitrary 3D unit vectors, not 6 axis-aligned options
//   - tips wander smoothly because each sub-step perturbs velocity by a
//     small random amount and then renormalizes — the path curves
//   - depth = unique voxels traversed (a voxel may take several sub-steps
//     to "exit", giving each tip slightly different progression rates)
function _growExplosion(sx, sy, sz, targetNodes) {
  const nodes = [];
  const depths = [];
  const visited = new Set();

  const somaVi = voxIdx(sx, sy, sz);
  visited.add(somaVi);
  nodes.push(somaVi);
  depths.push(0);
  let maxDepth = 0;

  // Per-burst tuning knobs:
  //   PRIMARY_COUNT  — primary tendril arms from soma
  //   TIP_SPEED      — voxels traveled per sub-step (small for smooth curves)
  //   SUB_STEPS      — sub-steps per outer pass (per "frame" of growth)
  //   PERTURB        — velocity jitter magnitude per sub-step (≈ curvature)
  //   SPLIT_PROB     — chance per outer pass a tip forks
  //   BRANCH_LIFE    — max sub-steps a tip can take before dying
  //   MAX_BRANCHES   — hard cap on simultaneous live tips
  //   MAX_PER_SHELL  — per-depth occupancy cap → keeps tendrils thin
  const PRIMARY_COUNT = 4 + Math.floor(burstRand() * 2);     // 4-5 arms
  const TIP_SPEED = 0.42;
  const SUB_STEPS = 3;
  const PERTURB = 0.32;
  const SPLIT_PROB = 0.04;
  const BRANCH_LIFE = Math.max(60, Math.round(VOXEL_GRID * 3));
  const MAX_BRANCHES = 7;
  const MAX_PER_SHELL = 8;

  // Active tips with continuous coords. Position starts at soma center
  // (+0.5 so floor(x) snaps to soma voxel).
  const tips = [];
  for (let i = 0; i < PRIMARY_COUNT; i++) {
    const dir = _randUnitVec();
    tips.push({
      x: sx + 0.5, y: sy + 0.5, z: sz + 0.5,
      vx: dir.vx, vy: dir.vy, vz: dir.vz,
      depth: 0,
      life: BRANCH_LIFE
    });
  }
  const shellCount = new Map();
  shellCount.set(0, 1);

  let safety = targetNodes * 8;
  while (nodes.length < targetNodes && tips.length > 0 && safety-- > 0) {
    for (let ti = tips.length - 1; ti >= 0; ti--) {
      if (nodes.length >= targetNodes) break;
      const tip = tips[ti];
      if (tip.life <= 0) { tips.splice(ti, 1); continue; }

      let tipDied = false;
      for (let s = 0; s < SUB_STEPS; s++) {
        // Perturb velocity slightly, then renormalize back to a unit vector
        // — this is what produces smooth organic curves instead of straight
        // pipes or 90° turns.
        tip.vx += (burstRand() * 2 - 1) * PERTURB;
        tip.vy += (burstRand() * 2 - 1) * PERTURB;
        tip.vz += (burstRand() * 2 - 1) * PERTURB;
        const len = Math.sqrt(tip.vx*tip.vx + tip.vy*tip.vy + tip.vz*tip.vz);
        if (len < 0.0001) { tipDied = true; break; }
        const inv = 1 / len;
        tip.vx *= inv; tip.vy *= inv; tip.vz *= inv;

        // Advance position by TIP_SPEED along velocity
        tip.x += tip.vx * TIP_SPEED;
        tip.y += tip.vy * TIP_SPEED;
        tip.z += tip.vz * TIP_SPEED;
        tip.life--;

        const ix = Math.floor(tip.x);
        const iy = Math.floor(tip.y);
        const iz = Math.floor(tip.z);
        if (!voxInBounds(ix, iy, iz)) { tipDied = true; break; }
        const vi = voxIdx(ix, iy, iz);
        if (!visited.has(vi)) {
          const newDepth = tip.depth + 1;
          const occ = shellCount.get(newDepth) || 0;
          if (occ >= MAX_PER_SHELL) { tipDied = true; break; }
          visited.add(vi);
          nodes.push(vi);
          depths.push(newDepth);
          shellCount.set(newDepth, occ + 1);
          tip.depth = newDepth;
          if (newDepth > maxDepth) maxDepth = newDepth;
        }
      }
      if (tipDied) { tips.splice(ti, 1); continue; }

      // Occasional split — spawn a child tip with velocity perpendicular to
      // the parent. Cross-product gives a clean orthogonal direction (with
      // a small jitter added so two splits from the same axis don't overlap).
      if (tip.depth > 5 && burstRand() < SPLIT_PROB && tips.length < MAX_BRANCHES) {
        // Pick an arbitrary axis that's not parallel to tip velocity,
        // then cross-product to get perpendicular.
        let ax = 0, ay = 0, az = 0;
        if (Math.abs(tip.vx) < 0.9) ax = 1;
        else if (Math.abs(tip.vy) < 0.9) ay = 1;
        else az = 1;
        let cx = tip.vy * az - tip.vz * ay;
        let cy = tip.vz * ax - tip.vx * az;
        let cz = tip.vx * ay - tip.vy * ax;
        const clen = Math.sqrt(cx*cx + cy*cy + cz*cz);
        if (clen > 0.001) {
          const inv = 1 / clen;
          cx *= inv; cy *= inv; cz *= inv;
          // Mix in a bit of forward velocity so the split fans out at ~60°
          // not 90° — looks more like a natural dendrite branch.
          const forward = 0.45;
          let mx = cx * (1 - forward) + tip.vx * forward;
          let my = cy * (1 - forward) + tip.vy * forward;
          let mz = cz * (1 - forward) + tip.vz * forward;
          const mlen = Math.sqrt(mx*mx + my*my + mz*mz);
          mx /= mlen; my /= mlen; mz /= mlen;
          tips.push({
            x: tip.x, y: tip.y, z: tip.z,
            vx: mx, vy: my, vz: mz,
            depth: tip.depth,
            life: Math.max(20, (tip.life * 0.65) | 0)
          });
        }
      }
    }
  }

  return { nodes, depths, maxDepth: Math.max(1, maxDepth) };
}

class Burst {
  // soma: {x,y,z} integer voxel coords
  // somaColor / secondaryColor: [r,g,b] 0..255 each
  // opts: { intensity, lifespan, apFrames, kind, label, targetNodes }
  constructor(soma, somaColor, secondaryColor, opts) {
    const o = opts || {};
    this.kind = o.kind || "burst";
    this.label = o.label || this.kind;
    this.somaColor = somaColor;
    this.secondary = secondaryColor;
    this.intensity = o.intensity != null ? o.intensity : 1;
    this.lifespan = o.lifespan || 90;
    this.apFrames = o.apFrames || 20;
    this.age = 0;
    this.apProg = 0;
    this.dead = false;

    const grown = _growExplosion(soma.x, soma.y, soma.z,
                                 o.targetNodes || DEFAULT_BURST_NODES);
    this.nodes = grown.nodes;
    this.depths = grown.depths;
    this.maxDepth = grown.maxDepth;

    // Precompute per-node color: lerp soma → secondary by depth/maxDepth.
    // Soma + inner shells are pure soma color; outer shells diffuse toward
    // the secondary hue. Per-shell coloring, not per-path-index — gives the
    // "expanding colored shockwave" feel.
    const N = this.nodes.length;
    this.colors = new Array(N);
    for (let i = 0; i < N; i++) {
      const t = this.depths[i] / this.maxDepth;
      this.colors[i] = [
        somaColor[0] * (1 - t) + secondaryColor[0] * t,
        somaColor[1] * (1 - t) + secondaryColor[1] * t,
        somaColor[2] * (1 - t) + secondaryColor[2] * t
      ];
    }
  }

  step() {
    this.age++;
    if (this.age > this.lifespan) { this.dead = true; return true; }

    // Envelope: fast 5-frame attack, then long decay over the remaining
    // lifespan. "Punch then fade" feel.
    const ATTACK = 5;
    let env;
    if (this.age < ATTACK) env = this.age / ATTACK;
    else env = 1 - ((this.age - ATTACK) / (this.lifespan - ATTACK));
    if (env < 0) env = 0;
    const energy = this.intensity * env;

    // Advance the AP wavefront FIRST so structure + signal both see the new
    // wave position this frame.
    if (this.apProg < 1) {
      this.apProg = Math.min(1, this.apProg + 1 / this.apFrames);
    }
    const waveDepth = this.apProg * (this.maxDepth + 1);

    const N = this.nodes.length;

    // Dendrite structure pass — voxels are ONLY lit once the wavefront has
    // reached their depth. That's the "grow" effect: as the wave expands
    // outward over apFrames frames, more of the tree becomes visible.
    // Voxels ahead of the wave stay dark — they "haven't grown yet."
    // Brightness still tapers with depth so tips read as faint.
    const structFalloff = 0.5;
    for (let i = 0; i < N; i++) {
      const d = this.depths[i];
      if (d > waveDepth) continue;                         // not yet grown
      const t = d / this.maxDepth;
      const want = energy * (1 - t * structFalloff);
      const vi = this.nodes[i];
      if (voxStructure[vi] < want) voxStructure[vi] = want;
      paintVoxelColor(vi, this.colors[i]);
    }

    // Action potential pass — bright shell at the wavefront so the GROWING
    // TIP of every branch glows extra brightly. Width is narrow (1.6 depth
    // units) so it reads as a thin advancing edge, not a thick blob.
    if (this.apProg < 1) {
      const W = 1.6;
      for (let i = 0; i < N; i++) {
        const d = this.depths[i];
        const dist = Math.abs(d - waveDepth);
        if (dist >= W) continue;
        const falloff = 1 - dist / W;
        const want = energy * falloff * 1.3;
        const vi = this.nodes[i];
        if (voxSignal[vi] < want) voxSignal[vi] = want;
      }
    }

    return false;
  }
}

function spawnBurst(soma, somaColor, secondaryColor, opts) {
  if (BURSTS.length >= BURST_CAP) BURSTS.shift();   // oldest first out
  const b = new Burst(soma, somaColor, secondaryColor, opts);
  BURSTS.push(b);
  return b;
}

function stepBursts() {
  for (let i = BURSTS.length - 1; i >= 0; i--) {
    if (BURSTS[i].step()) BURSTS.splice(i, 1);
  }
}
