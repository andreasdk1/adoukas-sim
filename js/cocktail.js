// Martini on the rocks: playback of a pre-computed simulation of the drink
// (ice melting, dilution, convection, heat in from the room) plus a live
// natural-convection solve of the room air around the glass.
(function () {
  'use strict';
  const BASE = '../assets/cases/cocktail/';
  const el = id => document.getElementById(id);
  const stage = el('ck-stage');
  const cv = el('ck-canvas'), cx = cv.getContext('2d');
  const cvP = el('ck-particles'), px = cvP.getContext('2d');
  const chart = el('ck-chart'), chx = chart.getContext('2d');

  function loadImg(src) {
    return new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = src; });
  }
  function pixels(img) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, img.width, img.height).data;
  }

  Promise.all([fetch(BASE + 'meta.json').then(r => r.json()), loadImg(BASE + 'fields.png'), loadImg(BASE + 'vel.png'), loadImg(BASE + 'material.png')])
    .then(([meta, fImg, vImg, mImg]) => init(meta, pixels(fImg), pixels(vImg), pixels(mImg)))
    .catch(() => { el('ck-status').textContent = 'Could not load the simulation data.'; });

  function init(meta, F, V, Mt) {
    const NX = meta.nx, NY = meta.ny, NF = meta.frames.length, CELL = meta.cell_mm;
    const WMM = NX * CELL, HMM = NY * CELL;
    const [TLO, THI] = meta.T_range, ABVHI = meta.abv_range[1], VMAX = meta.v_max;
    const TROOM = meta.T_room, TDEW = meta.T_dew, Gm = meta.geometry;
    const frameSize = NX * NY * 4;

    // material per data cell (row 0 = top): 0 air, 1 glass, 2 liquid
    const mat = new Uint8Array(NX * NY);
    for (let k = 0; k < NX * NY; k++) mat[k] = Math.round(Mt[k * 4] / 100);

    // decoded field access, frame f, data cell (c, r) with r=0 at top
    const Tof = (f, k) => TLO + F[f * frameSize + k * 4] / 255 * (THI - TLO);
    const ABVof = (f, k) => F[f * frameSize + k * 4 + 1] / 255 * ABVHI;
    const FSof = (f, k) => F[f * frameSize + k * 4 + 2] / 255;
    const Uof = (f, k) => (V[f * frameSize + k * 4] / 255 * 2 - 1) * VMAX;
    const Vof = (f, k) => (V[f * frameSize + k * 4 + 1] / 255 * 2 - 1) * VMAX;

    // ------------------------------------------------------------ view state
    const st = { pos: 0, playing: true, speed: 1, view: 'temp' };
    let W = 0, H = 0, sc = 1;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const off = document.createElement('canvas'); off.width = NX; off.height = NY;
    const ox = off.getContext('2d'); const img = ox.createImageData(NX, NY);

    function resize() {
      // fit the whole glass in the window with room to spare (toolbar, legend, nav)
      stage.style.width = '';
      const avail = stage.getBoundingClientRect().width;
      const maxH = Math.max(320, window.innerHeight - 260);
      W = Math.min(avail, maxH * WMM / HMM); H = W * HMM / WMM;
      stage.style.width = W + 'px'; stage.style.height = H + 'px';
      for (const c of [cv, cvP]) {
        c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
        c.style.width = W + 'px'; c.style.height = H + 'px';
        c.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
      }
      sc = W / WMM;
      const cr = chart.getBoundingClientRect();
      chart.width = Math.round(cr.width * DPR); chart.height = Math.round(cr.height * DPR);
      chx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    const X = xmm => xmm * sc, Y = ymm => (HMM - ymm) * sc;

    // ----------------------------------------------------------- colour maps
    function lut(stops) {
      const out = new Uint8ClampedArray(256 * 3);
      for (let k = 0; k < 256; k++) {
        const t = k / 255; let a = 0;
        while (a < stops.length - 2 && t > stops[a + 1][0]) a++;
        const [t0, c0] = stops[a], [t1, c1] = stops[a + 1], f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
        for (let ch = 0; ch < 3; ch++) out[k * 3 + ch] = c0[ch] + (c1[ch] - c0[ch]) * f;
      }
      return out;
    }
    // temperature: −10 … 25 °C, ice blue through to warm amber
    const TMAP = lut([[0, [24, 34, 104]], [0.29, [42, 104, 208]], [0.45, [96, 190, 232]], [0.66, [226, 236, 250]], [0.86, [242, 186, 110]], [1, [217, 96, 59]]]);
    const TMIN = -10, TMAX = 25;
    // dilution: water (0 % ABV) → martini (30 %)
    const AMAP = lut([[0, [70, 170, 235]], [0.5, [150, 200, 210]], [1, [236, 200, 106]]]);

    // ------------------------------------------------- live air (natural convection)
    const nx = NX, ny = NY, n = ny, N = nx * ny;     // air grid = data grid, j=0 at bottom
    const dxa = CELL / 1000, G = 9.81, BETA = 1 / (273.15 + TROOM), NU = 1.5e-5, ALPHA_A = 2.2e-5;
    const s = new Float32Array(N), u = new Float32Array(N), v = new Float32Array(N);
    const nu = new Float32Array(N), nv = new Float32Array(N);
    const Ta = new Float32Array(N).fill(TROOM), nTa = new Float32Array(N);
    const dataK = (i, j) => (NY - 1 - j) * NX + i;   // grid (i, j up) -> data cell index
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      s[i * n + j] = (mat[dataK(i, j)] === 0 && j > 0) ? 1 : 0;   // j = 0 is the table
    }
    function solidT(f0, f1, w) {
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const c = i * n + j;
        if (s[c] === 0 && j > 0) { const k = dataK(i, j); Ta[c] = Tof(f0, k) * (1 - w) + Tof(f1, k) * w; }
        if (j === 0) Ta[c] = TROOM;
      }
    }
    function sample(x, y, f, dx, dy) {
      x = Math.max(Math.min(x, nx - 1), 0); y = Math.max(Math.min(y, ny - 1), 0);
      const x0 = Math.min(Math.floor(x - dx), nx - 2), y0 = Math.min(Math.floor(y - dy), ny - 2);
      const tx = Math.min(1, Math.max(0, x - dx - x0)), ty = Math.min(1, Math.max(0, y - dy - y0));
      const a = Math.max(x0, 0), b = Math.max(y0, 0);
      return (1 - tx) * (1 - ty) * f[a * n + b] + tx * (1 - ty) * f[(a + 1) * n + b] + tx * ty * f[(a + 1) * n + b + 1] + (1 - tx) * ty * f[a * n + b + 1];
    }
    function airStep(dt) {
      const k = dt / dxa;                           // cells per (m/s)
      // buoyancy on v faces between two air cells
      for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
        const c = i * n + j;
        if (s[c] && s[c - 1]) v[c] += dt * G * BETA * (0.5 * (Ta[c] + Ta[c - 1]) - TROOM);
      }
      // viscosity
      nu.set(u); nv.set(v);
      for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
        const c = i * n + j;
        if (s[c] && s[c - n]) nu[c] = u[c] + dt * NU / (dxa * dxa) * (u[c - n] + u[c + n] + (s[c + 1] ? u[c + 1] : -u[c]) + (s[c - 1] ? u[c - 1] : -u[c]) - 4 * u[c]);
        if (s[c] && s[c - 1]) nv[c] = v[c] + dt * NU / (dxa * dxa) * (v[c - 1] + v[c + 1] + (s[c + n] ? v[c + n] : -v[c]) + (s[c - n] ? v[c - n] : -v[c]) - 4 * v[c]);
      }
      u.set(nu); v.set(nv);
      // projection; the outer ring of cells acts as an open boundary to the room
      for (let it = 0; it < 30; it++) {
        for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
          const c = i * n + j; if (!s[c]) continue;
          const sx0 = s[c - n], sx1 = s[c + n], sy0 = s[c - 1], sy1 = s[c + 1], ss = sx0 + sx1 + sy0 + sy1;
          if (!ss) continue;
          const p = -1.9 * (u[c + n] - u[c] + v[c + 1] - v[c]) / ss;
          u[c] -= sx0 * p; u[c + n] += sx1 * p; v[c] -= sy0 * p; v[c + 1] += sy1 * p;
        }
      }
      for (let j = 0; j < ny; j++) { u[j] = u[n + j]; v[j] = v[n + j]; u[(nx - 1) * n + j] = u[(nx - 2) * n + j]; v[(nx - 1) * n + j] = v[(nx - 2) * n + j]; }
      for (let i = 0; i < nx; i++) { u[i * n + ny - 1] = u[i * n + ny - 2]; v[i * n + ny - 1] = v[i * n + ny - 2]; }
      // advect velocity
      nu.set(u); nv.set(v);
      for (let i = 1; i < nx; i++) for (let j = 1; j < ny - 1; j++) {
        const c = i * n + j;
        if (s[c] && s[c - n]) {
          const vv = 0.25 * (v[c - n] + v[c] + v[c - n + 1] + v[c + 1]);
          nu[c] = sample(i - u[c] * k, j + 0.5 - vv * k, u, 0, 0.5);
        }
        if (s[c] && s[c - 1] && i < nx - 1) {
          const uu = 0.25 * (u[c - 1] + u[c] + u[c + n - 1] + u[c + n]);
          nv[c] = sample(i + 0.5 - uu * k, j - v[c] * k, v, 0.5, 0);
        }
      }
      u.set(nu); v.set(nv);
      // air temperature: advection, then diffusion of the advected field (operator
      // split, so the update stays bounded); solids hold the glass/drink temperature
      nTa.set(Ta);
      for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
        const c = i * n + j;
        if (!s[c]) continue;
        const uc = 0.5 * (u[c] + u[c + n]), vc = 0.5 * (v[c] + v[c + 1]);
        nTa[c] = sample(i + 0.5 - uc * k, j + 0.5 - vc * k, Ta, 0.5, 0.5);
      }
      const dif = dt * ALPHA_A / (dxa * dxa);
      for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
        const c = i * n + j;
        Ta[c] = s[c] ? nTa[c] + dif * (nTa[c - n] + nTa[c + n] + nTa[c - 1] + nTa[c + 1] - 4 * nTa[c]) : nTa[c];
      }
      for (let i = 0; i < nx; i++) { Ta[i * n + ny - 1] = TROOM; }
      for (let j = 0; j < ny; j++) { Ta[j] = TROOM; Ta[(nx - 1) * n + j] = TROOM; }
    }

    // --------------------------------------------------------- droplets
    // Condensation on the outside of the bowl: drops nucleate where the glass is
    // below the dew point, grow at a rate set by how far below it is, merge with
    // neighbours, and once heavy enough slide down the bowl (sweeping up the
    // drops in their path) and run down the stem. Growth follows simulated time;
    // the sliding itself is animated in real time.
    const tanA = Gm.half_rim_in / (Gm.rim_y - Gm.apex_in);
    const ALPHA = Math.atan(tanA), SINA = Math.sin(ALPHA), COSA = Math.cos(ALPHA);
    const LWALL = (Gm.rim_y - 2 - (Gm.apex_out + 3)) / COSA;           // usable slant length of the bowl, mm
    const STEM_TOP = Gm.apex_out + 1, STEM_BOT = 21, STEM_X = 3.2;
    const R_SLIDE = 1.25, GROW = 4.5e-4, DRY = 2.5e-4;                 // mm, mm/(s·K)
    let drops = [], tPrev = 0;
    function onWall(d) {                                               // drop centre in mm
      if (d.seg === 0) {
        const y = Gm.rim_y - 2 - d.s * COSA;
        return [Gm.cx + d.side * ((y - Gm.apex_out) * tanA + d.r * 0.9), y];
      }
      return [Gm.cx + d.side * (STEM_X + d.r * 0.9), STEM_TOP - d.s];
    }
    function glassT(d, f0, f1, w) {                                    // glass temperature under the drop
      const [x, y] = onWall(d);
      const xi = x - d.side * (d.r * 0.9 + 1.6);
      const k = Math.min(NY - 1, Math.max(0, Math.floor((HMM - y) / CELL))) * NX + Math.min(NX - 1, Math.max(0, Math.floor(xi / CELL)));
      return Tof(f0, k) * (1 - w) + Tof(f1, k) * w;
    }
    function dropsStep(dts, f0, f1, w, animate, dtReal) {
      // nucleation, proportional to simulated time
      const tries = Math.min(40, Math.round(dts * 0.25 + (Math.random() < (dts * 0.25) % 1 ? 1 : 0)));
      for (let k = 0; k < tries && drops.length < 260; k++) {
        const d = { side: Math.random() < 0.5 ? -1 : 1, seg: 0, s: Math.random() * LWALL, r: 0.25, slide: false, v: 0, trail: [] };
        if (glassT(d, f0, f1, w) < TDEW - 0.5) drops.push(d);
      }
      for (const d of drops) {
        if (d.slide) continue;
        const T = glassT(d, f0, f1, w);
        d.r += dts * (T < TDEW ? GROW * (TDEW - T) : -DRY * (T - TDEW));
        if (d.r > R_SLIDE) d.slide = true;
      }
      // sliding (real time when animating; instant when fast-forwarding)
      for (const d of drops) {
        if (!d.slide) continue;
        if (!animate) { d.r = 0; continue; }
        d.v = Math.min(45, d.v + 120 * dtReal);                       // mm/s on screen
        const before = onWall(d);
        d.s += d.v * dtReal;
        if (d.seg === 0 && d.s > LWALL) { d.seg = 1; d.s = 0; }
        if (d.seg === 1 && STEM_TOP - d.s < STEM_BOT) d.r = 0;
        d.trail.push(before); if (d.trail.length > 14) d.trail.shift();
      }
      // coalescence along the same side and segment
      drops.sort((a, b) => a.side - b.side || a.seg - b.seg || a.s - b.s);
      for (let i = 0; i < drops.length - 1; i++) {
        const a = drops[i], b = drops[i + 1];
        if (a.r <= 0 || b.r <= 0 || a.side !== b.side || a.seg !== b.seg) continue;
        if (Math.abs(a.s - b.s) < (a.r + b.r) * 0.9 && Math.random() < 0.85) {
          const keep = a.slide || (!b.slide && a.r >= b.r) ? a : b, gone = keep === a ? b : a;
          keep.r = Math.cbrt(keep.r ** 3 + gone.r ** 3); gone.r = 0;
          if (keep.r > R_SLIDE) keep.slide = true;
        }
      }
      drops = drops.filter(d => d.r > 0.12);
    }
    function dropsTo(t, f0, f1, w) {                                   // rebuild state after a jump back
      drops = []; let tt = 0;
      while (tt < t) {
        const dts = Math.min(20, t - tt); tt += dts;
        const [g0, g1, gw] = frameAt(posOfTime(tt));
        dropsStep(dts, g0, g1, gw, false, 0);
      }
      tPrev = t;
    }
    const times = meta.frames.map(f => f.t);
    function posOfTime(t) {
      let a = 0; while (a < NF - 2 && times[a + 1] < t) a++;
      return a + Math.min(1, Math.max(0, (t - times[a]) / (times[a + 1] - times[a])));
    }
    function updateDrops(f0, f1, w, dtReal) {
      const t = times[f0] * (1 - w) + times[f1] * w;
      if (t < tPrev - 1 || t - tPrev > 120) dropsTo(t, f0, f1, w);
      else { dropsStep(Math.max(0, t - tPrev), f0, f1, w, true, dtReal); tPrev = t; }
    }

    // --------------------------------------------------------- particles
    const PL = Array.from({ length: 260 }, () => ({ x: 0, y: 0, life: 0 }));
    const PA = Array.from({ length: 420 }, () => ({ x: 0, y: 0, life: 0 }));
    const liquidCells = []; for (let k = 0; k < NX * NY; k++) if (mat[k] === 2) liquidCells.push(k);
    function spawnL(p) { const k = liquidCells[(Math.random() * liquidCells.length) | 0]; p.x = (k % NX) + Math.random(); p.y = ((k / NX) | 0) + Math.random(); p.life = 40 + Math.random() * 80; }
    function spawnA(p) { p.x = 1 + Math.random() * (nx - 2); p.y = 1 + Math.random() * (ny - 2); p.life = 60 + Math.random() * 160; }
    PL.forEach(spawnL); PA.forEach(spawnA);

    // ABV in the top and bottom 15 mm of the drink, liquid cells only (not ice)
    meta.frames.forEach((fr, f) => {
      let ts = 0, tn = 0, bs = 0, bn = 0, as = 0, an = 0;
      for (let k = 0; k < NX * NY; k++) {
        if (mat[k] !== 2 || FSof(f, k) > 0.02) continue;
        const ymm = HMM - ((k / NX | 0) + 0.5) * CELL, a = ABVof(f, k);
        as += a; an++;
        if (ymm > Gm.fill_y - 15) { ts += a; tn++; }
        if (ymm < Gm.apex_in + 15) { bs += a; bn++; }
      }
      fr.abv_top = tn ? ts / tn : 0; fr.abv_bot = bn ? bs / bn : 0; fr.abv_mean = an ? as / an : 0;
    });

    // ------------------------------------------------------------ render
    function frameAt(pos) { pos = Math.max(0, pos); const f0 = Math.min(NF - 1, Math.floor(pos)); return [f0, Math.min(NF - 1, f0 + 1), pos - f0]; }
    function draw() {
      const [f0, f1, w] = frameAt(st.pos);
      const d = img.data;
      for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
        const k = r * NX + c, o = k * 4, m = mat[k];
        if (m === 0) {
          const ta = Ta[c * n + (NY - 1 - r)], dev = ta - TROOM;
          if (st.view === 'temp' && dev < -0.2) {
            // air: shown as how much colder than the room it is (cool blue, deeper = colder)
            const f = Math.min(1, -dev / 12);
            d[o] = 120 - 80 * f; d[o + 1] = 200 - 90 * f; d[o + 2] = 245 - 25 * f; d[o + 3] = Math.min(210, -dev * 26);
          } else d[o + 3] = 0;
          continue;
        }
        const T = Tof(f0, k) * (1 - w) + Tof(f1, k) * w;
        const fs = FSof(f0, k) * (1 - w) + FSof(f1, k) * w;
        let R, Gc, B;
        if (st.view === 'abv' && m === 2) {
          const a = ABVof(f0, k) * (1 - w) + ABVof(f1, k) * w;
          const q = Math.max(0, Math.min(255, ((a - 0.2) / 0.1 * 255) | 0)) * 3;   // 20–30 % ABV, where the action is
          R = AMAP[q]; Gc = AMAP[q + 1]; B = AMAP[q + 2];
        } else if (st.view === 'flow' && m === 2) {
          R = 22; Gc = 36; B = 70;
        } else {
          const q = Math.max(0, Math.min(255, ((T - TMIN) / (TMAX - TMIN) * 255) | 0)) * 3;
          R = TMAP[q]; Gc = TMAP[q + 1]; B = TMAP[q + 2];
        }
        if (m === 1) { R = R * 0.55 + 110; Gc = Gc * 0.55 + 118; B = B * 0.55 + 130; }   // glass: paler
        if (fs > 0.02) { const a = Math.min(0.85, fs * 0.85); R += (238 - R) * a; Gc += (246 - Gc) * a; B += (255 - B) * a; }
        d[o] = R; d[o + 1] = Gc; d[o + 2] = B; d[o + 3] = 255;
      }
      ox.putImageData(img, 0, 0);
      cx.clearRect(0, 0, W, H);
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(off, 0, 0, W, H);
      drawGlass();
      drawDrops();
    }
    function drawGlass() {
      const g = Gm, t = g.wall, xo = (g.rim_y - g.apex_out) * tanA;
      cx.save();
      cx.lineJoin = 'round';
      // outer silhouette
      cx.strokeStyle = 'rgba(235,242,255,0.75)'; cx.lineWidth = 1.3;
      cx.beginPath();
      cx.moveTo(X(g.cx - xo), Y(g.rim_y)); cx.lineTo(X(g.cx - 3.2), Y(g.apex_out + 2.5));
      cx.lineTo(X(g.cx - 3.2), Y(22)); cx.quadraticCurveTo(X(g.cx - 5.5), Y(19.5), X(g.cx - 36), Y(19.5));
      cx.lineTo(X(g.cx - 36), Y(15)); cx.lineTo(X(g.cx + 36), Y(15)); cx.lineTo(X(g.cx + 36), Y(19.5));
      cx.quadraticCurveTo(X(g.cx + 5.5), Y(19.5), X(g.cx + 3.2), Y(22)); cx.lineTo(X(g.cx + 3.2), Y(g.apex_out + 2.5));
      cx.lineTo(X(g.cx + xo), Y(g.rim_y)); cx.stroke();
      // inner surface and rim
      cx.strokeStyle = 'rgba(235,242,255,0.45)'; cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(X(g.cx - g.half_rim_in), Y(g.rim_y)); cx.lineTo(X(g.cx), Y(g.apex_in)); cx.lineTo(X(g.cx + g.half_rim_in), Y(g.rim_y)); cx.stroke();
      cx.strokeStyle = 'rgba(255,255,255,0.9)'; cx.lineWidth = 1.6;
      cx.beginPath(); cx.moveTo(X(g.cx - xo), Y(g.rim_y)); cx.lineTo(X(g.cx - g.half_rim_in), Y(g.rim_y));
      cx.moveTo(X(g.cx + g.half_rim_in), Y(g.rim_y)); cx.lineTo(X(g.cx + xo), Y(g.rim_y)); cx.stroke();
      // glossy highlight on the left wall
      const grd = cx.createLinearGradient(X(g.cx - xo), 0, X(g.cx - xo + 8), 0);
      grd.addColorStop(0, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      cx.strokeStyle = grd; cx.lineWidth = 3;
      cx.beginPath(); cx.moveTo(X(g.cx - xo + 4), Y(g.rim_y - 6)); cx.lineTo(X(g.cx - 14), Y(g.apex_out + 22)); cx.stroke();
      // liquid surface
      const hw = (g.fill_y - g.apex_in) * tanA;
      cx.strokeStyle = 'rgba(255,255,255,0.55)'; cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(X(g.cx - hw), Y(g.fill_y)); cx.lineTo(X(g.cx + hw), Y(g.fill_y)); cx.stroke();
      cx.restore();
    }
    function drawDrops() {
      for (const d of drops) {
        const [xm, ym] = onWall(d), x = X(xm), y = Y(ym), r = Math.max(0.6, d.r * sc);
        if (d.slide && d.trail.length > 1) {                          // wet streak behind a sliding drop
          cx.strokeStyle = 'rgba(190,215,250,0.22)'; cx.lineWidth = r * 1.1; cx.lineCap = 'round';
          cx.beginPath(); d.trail.forEach(([tx, ty], i) => (i ? cx.lineTo(X(tx), Y(ty)) : cx.moveTo(X(tx), Y(ty)))); cx.lineTo(x, y); cx.stroke();
        }
        cx.fillStyle = 'rgba(185,212,250,0.32)';
        cx.beginPath(); cx.ellipse(x, y + r * 0.08, r * 0.92, r * (d.slide ? 1.25 : 1.05), 0, 0, Math.PI * 2); cx.fill();
        cx.strokeStyle = 'rgba(235,244,255,0.45)'; cx.lineWidth = 0.6; cx.stroke();
        cx.fillStyle = 'rgba(255,255,255,0.8)';
        cx.beginPath(); cx.arc(x - r * 0.32, y - r * 0.35, Math.max(0.4, r * 0.28), 0, Math.PI * 2); cx.fill();
      }
    }
    function drawParticles(f0, f1, w) {
      px.globalCompositeOperation = 'destination-out';
      px.fillStyle = 'rgba(0,0,0,0.12)'; px.fillRect(0, 0, W, H);
      px.globalCompositeOperation = 'source-over';
      const cs = CELL * sc;
      // liquid (time-lapse direction of the stored flow)
      px.strokeStyle = st.view === 'flow' ? 'rgba(170,215,255,0.9)' : 'rgba(255,255,255,0.45)';
      px.lineWidth = st.view === 'flow' ? 1.2 : 0.9;
      px.beginPath();
      for (const p of PL) {
        const k = Math.min(NY - 1, p.y | 0) * NX + Math.min(NX - 1, p.x | 0);
        if (mat[k] !== 2 || FSof(f0, k) > 0.5 || --p.life < 0) { spawnL(p); continue; }
        const uu = Uof(f0, k) * (1 - w) + Uof(f1, k) * w, vv = Vof(f0, k) * (1 - w) + Vof(f1, k) * w;
        const x2 = p.x + uu / VMAX * 0.9, y2 = p.y - vv / VMAX * 0.9;
        px.moveTo(p.x * cs, p.y * cs); px.lineTo(x2 * cs, y2 * cs);
        p.x = x2; p.y = y2;
      }
      px.stroke();
      // air (live, real time)
      px.strokeStyle = 'rgba(210,225,250,0.4)'; px.lineWidth = 0.9;
      px.beginPath();
      const k = 0.016 * 2 / dxa;
      for (const p of PA) {
        const uu = sample(p.x, p.y, u, 0, 0.5), vv = sample(p.x, p.y, v, 0.5, 0);
        const x2 = p.x + uu * k * 3, y2 = p.y + vv * k * 3;
        px.moveTo(p.x * cs, (ny - p.y) * cs); px.lineTo(x2 * cs, (ny - y2) * cs);
        p.x = x2; p.y = y2;
        const c = (p.x | 0) * n + (p.y | 0);
        if (--p.life < 0 || p.x < 1 || p.y < 1 || p.x > nx - 2 || p.y > ny - 2 || !s[c]) spawnA(p);
      }
      px.stroke();
    }

    // ------------------------------------------------------------- readouts
    function fmtT(t) {
      const m = Math.floor(t / 60), sec = Math.floor(t % 60);
      return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m}:${String(sec).padStart(2, '0')} min`;
    }
    function lerpStat(key) { const [f0, f1, w] = frameAt(st.pos); return meta.frames[f0][key] * (1 - w) + meta.frames[f1][key] * w; }
    function readouts() {
      const t = lerpStat('t');
      el('ck-time').textContent = fmtT(t);
      el('ck-drink').textContent = lerpStat('T_drink').toFixed(1) + ' °C';
      el('ck-ice').textContent = Math.max(0, lerpStat('ice') * 100).toFixed(0) + ' %';
      el('ck-abv').textContent = `${(lerpStat('abv_top') * 100).toFixed(0)} % / ${(lerpStat('abv_bot') * 100).toFixed(0)} %`;
      const wet = lerpStat('wet');
      el('ck-dew').textContent = wet > 0.02 ? `wet · ${Math.round(wet * 100)} %` : 'dry';
      el('ck-scrub').value = st.pos;
    }
    // small chart: drink temperature and ice remaining vs time
    function drawChart() {
      const w = chart.width / DPR, h = chart.height / DPR, pad = 6;
      chx.clearRect(0, 0, w, h);
      const tEnd = meta.frames[NF - 1].t;
      const xt = t => pad + (t / tEnd) * (w - 2 * pad);
      const yT = T => h - pad - ((T - TMIN) / (TMAX - TMIN)) * (h - 2 * pad);
      const yI = f => h - pad - f * (h - 2 * pad);
      chx.strokeStyle = 'rgba(169,192,234,0.15)'; chx.lineWidth = 1;
      chx.beginPath(); chx.moveTo(pad, yT(TDEW)); chx.lineTo(w - pad, yT(TDEW)); chx.stroke();
      chx.lineWidth = 1.6;
      chx.strokeStyle = '#e9c46a'; chx.beginPath();
      meta.frames.forEach((fr, f) => (f ? chx.lineTo(xt(fr.t), yT(fr.T_drink)) : chx.moveTo(xt(fr.t), yT(fr.T_drink)))); chx.stroke();
      chx.strokeStyle = '#a9d8ff'; chx.beginPath();
      meta.frames.forEach((fr, f) => (f ? chx.lineTo(xt(fr.t), yI(fr.ice)) : chx.moveTo(xt(fr.t), yI(fr.ice)))); chx.stroke();
      const xc = xt(lerpStat('t'));
      chx.strokeStyle = 'rgba(255,255,255,0.8)'; chx.lineWidth = 1;
      chx.beginPath(); chx.moveTo(xc, pad); chx.lineTo(xc, h - pad); chx.stroke();
    }

    // ---------------------------------------------------------------- loop
    let last = performance.now(), running = false, raf = 0, onScreen = true;
    function frame(now) {
      const dtw = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;   // rAF time can precede start()
      if (st.playing) {
        st.pos += dtw * 1.6 * st.speed;
        if (st.pos >= NF - 1) { st.pos = NF - 1; st.playing = false; el('ck-play').textContent = 'Replay'; }
      }
      const [f0, f1, w] = frameAt(st.pos);
      solidT(f0, f1, w);
      airStep(0.016); airStep(0.016);
      updateDrops(f0, f1, w, dtw);
      draw(); drawParticles(f0, f1, w); readouts(); drawChart();
      if (running) raf = requestAnimationFrame(frame);
    }
    function start() { if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } }
    function stop() { running = false; cancelAnimationFrame(raf); }

    // ------------------------------------------------------------ controls
    const scrub = el('ck-scrub'); scrub.max = NF - 1; scrub.step = 0.01;
    scrub.addEventListener('input', () => { st.pos = +scrub.value; if (st.pos < NF - 1) el('ck-play').textContent = st.playing ? 'Pause' : 'Play'; });
    el('ck-play').addEventListener('click', () => {
      if (st.pos >= NF - 1) st.pos = 0;
      st.playing = !st.playing; el('ck-play').textContent = st.playing ? 'Pause' : 'Play';
    });
    document.querySelectorAll('input[name="ck-view"]').forEach(r => r.addEventListener('change', e => {
      st.view = e.target.value; px.clearRect(0, 0, W, H);
      el('ck-legend-temp').hidden = st.view !== 'temp';
      el('ck-legend-abv').hidden = st.view !== 'abv';
      el('ck-legend-flow').hidden = st.view !== 'flow';
    }));
    document.querySelectorAll('input[name="ck-speed"]').forEach(r => r.addEventListener('change', e => { st.speed = +e.target.value; }));

    resize();
    for (let k = 0; k < 150; k++) { solidT(0, 0, 0); airStep(0.016); }
    el('ck-status').hidden = true;
    start();
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop(); }).observe(stage);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : onScreen && start()));
    window.addEventListener('blur', stop);
    window.addEventListener('focus', () => onScreen && start());
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
  }
})();
