// Martini on the rocks: playback of a pre-computed simulation of the drink, the ice and the
// room air around the glass (melting, dilution, convection, heat in from the room).
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

  Promise.all([fetch(BASE + 'meta.json').then(r => r.json()), loadImg(BASE + 'fields.png'), loadImg(BASE + 'vel.png'), loadImg(BASE + 'material.png'), loadImg(BASE + 'ice.png'), loadImg(BASE + 'vela.png'),
               loadImg(BASE + 'vap.png').catch(() => null)])
    .then(([meta, fImg, vImg, mImg, iImg, aImg, pImg]) => init(meta, pixels(fImg), pixels(vImg), pixels(mImg), pixels(iImg), iImg.width, pixels(aImg), pImg && pixels(pImg)))
    .catch(() => { el('ck-status').textContent = 'Could not load the simulation data.'; });

  function init(meta, F, V, Mt, ICEPX, ICEWA, VA, VP) {
    const NX = meta.nx, NY = meta.ny, NF = meta.frames.length, CELL = meta.cell_mm;
    const WMM = NX * CELL, HMM = NY * CELL;
    const [TLO, THI] = meta.T_range, ABVHI = meta.abv_range[1], VMAX = meta.v_max;
    const TROOM = meta.T_room, TDEW = meta.T_dew, Gm = meta.geometry;
    // frames are tiles of an atlas (CA columns; older data: one tall strip, CA = 1)
    const CA = meta.atlas_cols || 1, CAI = meta.ice_atlas_cols || 1, NXA = NX * CA;
    const ICEW = ICEWA / CAI;
    const iat = (fr, nC, r, c) => ((((fr / CAI) | 0) * nC + r) * ICEWA + (fr % CAI) * ICEW + c) * 4;
    const at = (f, k) => ((((f / CA) | 0) * NY + ((k / NX) | 0)) * NXA + (f % CA) * NX + (k % NX)) * 4;

    // material per data cell (row 0 = top): 0 air, 1 glass, 2 liquid
    const mat = new Uint8Array(NX * NY);
    for (let k = 0; k < NX * NY; k++) mat[k] = Math.round(Mt[k * 4] / 100);

    // decoded field access, frame f, data cell (c, r) with r=0 at top
    const Tof = (f, k) => TLO + F[at(f, k)] / 255 * (THI - TLO);
    const ABVof = (f, k) => F[at(f, k) + 1] / 255 * ABVHI;
    const FSof = (f, k) => F[at(f, k) + 2] / 255;
    const Uof = (f, k) => (V[at(f, k)] / 255 * 2 - 1) * VMAX;
    const Vof = (f, k) => (V[at(f, k) + 1] / 255 * 2 - 1) * VMAX;
    const VMAXA = meta.v_max_air || 0.15;                                    // air velocity, from the simulation
    const AUof = (f, k) => (VA[at(f, k)] / 255 * 2 - 1) * VMAXA;
    const AVof = (f, k) => (VA[at(f, k) + 1] / 255 * 2 - 1) * VMAXA;
    // alcohol vapour in the air (kg per kg), from runs with evaporation; without it the view is hidden
    const EMAX = meta.vap_e_max || 0.04;
    const EVof = (f, k) => VP ? VP[at(f, k)] / 255 * EMAX : 0;
    if (!VP) { el('ck-view-evap').style.display = 'none'; el('ck-evap-row').style.display = 'none'; }
    // water on the glass (µm of film, thickest in each cell), from runs that track the condensate
    const HAS_FILM = !!VP && meta.frames[0].film_ul !== undefined;
    const FILMof = (f, k) => VP[at(f, k) + 2];

    // ------------------------------------------------------------ view state
    const st = { pos: 0, playing: true, speed: 0.25, view: 'temp' };
    let W = 0, H = 0, sc = 1;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const off = document.createElement('canvas'); off.width = NX; off.height = NY;
    const ox = off.getContext('2d'); const img = ox.createImageData(NX, NY);
    const goff = document.createElement('canvas'); goff.width = NX; goff.height = NY;   // glass layer
    const gx = goff.getContext('2d'); const gimg = gx.createImageData(NX, NY); const gd = gimg.data;
    const gpad = new Uint8ClampedArray(gd.length); const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]; const padSrc = new Uint8Array(NX * NY);

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

    // --------------------------------------------------------- droplets
    // Condensation on the outside of the bowl: drops nucleate where the glass is
    // below the dew point, grow at a rate set by how far below it is, merge with
    // neighbours, and once heavy enough slide down the bowl (sweeping up the
    // drops in their path) and run down the stem. Growth follows simulated time;
    // the sliding itself is animated in real time.
    const tanA = Gm.half_rim_in / (Gm.rim_y - Gm.apex_in);
    const ALPHA = Math.atan(tanA), SINA = Math.sin(ALPHA), COSA = Math.cos(ALPHA);
    const LWALL = (Gm.rim_y - 2 - (Gm.apex_out + 3)) / COSA;           // usable slant length of the bowl, mm
    const STEM_TOP = Gm.apex_out + 1, STEM_BOT = 21, STEM_X = 3.2, FOOT_TOP = 19.5, FOOT_X = 36;
    const R_SLIDE = 1.25, GROW = 4.5e-4, DRY = 2.5e-4;                 // mm, mm/(s·K)
    let drops = [], tPrev = 0;
    function onWall(d) {                                               // drop centre in mm
      if (d.seg === 0) {
        const y = Gm.rim_y - 2 - d.s * COSA;
        return [Gm.cx + d.side * ((y - Gm.apex_out) * tanA + d.r * 0.9), y];
      }
      if (d.seg === 1) return [Gm.cx + d.side * (STEM_X + d.r * 0.9), STEM_TOP - d.s];
      return [Gm.cx + d.side * (5.5 + d.s), FOOT_TOP + d.r * 0.8];        // over the foot, outwards
    }
    function wallFilm(d, f0, f1, w) {                                  // µm of water on the glass at the drop
      const [x, y] = onWall(d); let h = 0;
      for (const din of [0.3, 1.0, 1.8]) {
        const xi = x - d.side * (d.r * 0.9 + din);
        const k = Math.min(NY - 1, Math.max(0, Math.floor((HMM - y) / CELL))) * NX + Math.min(NX - 1, Math.max(0, Math.floor(xi / CELL)));
        h = Math.max(h, FILMof(f0, k) * (1 - w) + FILMof(f1, k) * w);
      }
      return h;
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
        const d = { side: Math.random() < 0.5 ? -1 : 1, seg: 0, s: Math.random() * LWALL, r: 0.25, slide: false, v: 0, trail: [], k: 0.8 + 0.35 * Math.random() };
        if (HAS_FILM ? wallFilm(d, f0, f1, w) > 2 : glassT(d, f0, f1, w) < TDEW - 0.5) drops.push(d);
      }
      for (const d of drops) {
        if (d.slide) continue;
        if (HAS_FILM) {
          // a drop's size follows the water the simulation has on the glass there: it grows while
          // water condenses, shrinks as it evaporates again, and slides once it is big enough to run
          // (about where the simulated film starts to run, 50 µm)
          const rt = R_SLIDE * d.k * Math.cbrt(wallFilm(d, f0, f1, w) / 50);
          d.r += (rt - d.r) * Math.min(1, dts / 20);
        } else {
          const T = glassT(d, f0, f1, w);
          d.r += dts * (T < TDEW ? GROW * (TDEW - T) : -DRY * (T - TDEW));
        }
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
        if (d.seg === 1 && STEM_TOP - d.s < STEM_BOT) { if (HAS_FILM) { d.seg = 2; d.s = 0; d.v *= 0.5; } else d.r = 0; }
        if (d.seg === 2) { d.v = Math.min(d.v, 18); if (d.s > FOOT_X - 5.5) d.r = 0; }   // runs off the foot's edge
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
    const airCells = []; for (let k = 0; k < NX * NY; k++) if (mat[k] === 0) airCells.push(k);
    function spawnA(p) { const k = airCells[(Math.random() * airCells.length) | 0]; p.x = (k % NX) + Math.random(); p.y = ((k / NX) | 0) + Math.random(); p.life = 60 + Math.random() * 160; }
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
          const ta = Tof(f0, k) * (1 - w) + Tof(f1, k) * w, dev = ta - TROOM;
          if (st.view === 'temp' && dev < -0.2) {
            // air: shown as how much colder than the room it is (cool blue, deeper = colder)
            const f = Math.min(1, -dev / 12);
            d[o] = 120 - 80 * f; d[o + 1] = 200 - 90 * f; d[o + 2] = 245 - 25 * f; d[o + 3] = Math.min(210, -dev * 26);
          } else if (st.view === 'evap') {
            // air: the alcohol vapour leaving the drink (lavender, brighter = more)
            const e = Math.min(1, (EVof(f0, k) * (1 - w) + EVof(f1, k) * w) / EMAX);
            d[o] = 156 + 60 * e; d[o + 1] = 134 + 70 * e; d[o + 2] = 224 + 31 * e; d[o + 3] = Math.min(235, e * 380);
          } else d[o + 3] = 0;
          continue;
        }
        // in the drink, weight each frame by how much liquid the cell holds in it: when a cube moves a long way
        // between two frames (the capsize), the cells it leaves would otherwise blend in the ice's own values
        // (0 °C, pure water) and flash up as a cold, diluted patch until the next frame
        const fs0 = FSof(f0, k), fs1 = FSof(f1, k);
        let w0 = 1 - w, w1 = w;
        if (m === 2) { const a0 = w0 * (1 - fs0), a1 = w1 * (1 - fs1), s_ = a0 + a1; if (s_ > 0.05) { w0 = a0 / s_; w1 = a1 / s_; } }
        const T = Tof(f0, k) * w0 + Tof(f1, k) * w1;
        const fs = fs0 * (1 - w) + fs1 * w;
        let R, Gc, B;
        if (st.view === 'abv' && m === 2) {
          const a = ABVof(f0, k) * w0 + ABVof(f1, k) * w1;
          const q = Math.max(0, Math.min(255, ((a - 0.2) / 0.1 * 255) | 0)) * 3;   // 20–30 % ABV, where the action is
          R = AMAP[q]; Gc = AMAP[q + 1]; B = AMAP[q + 2];
        } else if (st.view === 'flow' && m === 2) {
          R = 22; Gc = 36; B = 70;
        } else {
          const q = Math.max(0, Math.min(255, ((T - TMIN) / (TMAX - TMIN) * 255) | 0)) * 3;
          R = TMAP[q]; Gc = TMAP[q + 1]; B = TMAP[q + 2];
        }
        if (m === 1) {                                   // glass: paler; drawn separately, clipped to its shape
          gd[o] = R * 0.55 + 110; gd[o + 1] = Gc * 0.55 + 118; gd[o + 2] = B * 0.55 + 130; gd[o + 3] = 255;
          d[o + 3] = 0; continue;
        }
        if (fs > 0.02) { const a = Math.min(0.35, fs * 0.35); R += (238 - R) * a; Gc += (246 - Gc) * a; B += (255 - B) * a; }
        d[o] = R; d[o + 1] = Gc; d[o + 2] = B; d[o + 3] = 255;
      }
      // pad the glass colours a cell outwards, so smoothing doesn't fade the clipped edge
      for (let pass = 0; pass < 2; pass++) {
        gpad.set(gd);
        for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
          const o = (r * NX + c) * 4; if (gd[o + 3]) continue;
          for (const [dr, dc] of NB4) {
            const rr = r + dr, cc = c + dc; if (rr < 0 || rr >= NY || cc < 0 || cc >= NX) continue;
            const q = (rr * NX + cc) * 4; if (!gd[q + 3]) continue;
            gpad[o] = gd[q]; gpad[o + 1] = gd[q + 1]; gpad[o + 2] = gd[q + 2]; gpad[o + 3] = 255; break;
          }
        }
        gd.set(gpad);
      }
      // and the drink's (or else the air's) colours a cell under the glass, so both meet the exact
      // wall line instead of leaving a staircase of unpainted specks along it
      // (two steps, the second from cells filled in the first: reaches into the narrow tip of the V)
      padSrc.fill(0);
      for (let pass = 1; pass <= 2; pass++) for (let k = 0; k < NX * NY; k++) {
        if (mat[k] !== 1 || padSrc[k]) continue;
        const r = (k / NX) | 0, c = k % NX, o = k * 4;
        let src = -1, best = 0;
        for (const [dr, dc] of NB8) {
          const rr = r + dr, cc = c + dc; if (rr < 0 || rr >= NY || cc < 0 || cc >= NX) continue;
          const q = rr * NX + cc;
          // drink first, then air; in the second pass also cells filled in the first
          const rank = mat[q] === 2 || padSrc[q] === 2 ? 3 : mat[q] === 0 || padSrc[q] === 3 ? 2 : 0;
          if (rank > best && !(pass === 1 && padSrc[q])) { best = rank; src = q; }
        }
        if (src >= 0) {
          const q4 = src * 4; d[o] = d[q4]; d[o + 1] = d[q4 + 1]; d[o + 2] = d[q4 + 2]; d[o + 3] = d[q4 + 3];
          padSrc[k] = best === 3 ? 2 : 3;
        }
      }
      ox.putImageData(img, 0, 0); gx.putImageData(gimg, 0, 0);
      for (let k = 0; k < NX * NY; k++) if (mat[k] !== 1) gd[k * 4 + 3] = 0;   // reset the padding
      cx.clearRect(0, 0, W, H);
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(off, 0, 0, W, H);
      cx.save(); glassPath(); cx.clip('evenodd'); cx.drawImage(goff, 0, 0, W, H); cx.restore();
      drawIce(f0, f1, w);
      drawSurface(f0, f1, w);
      drawGlass();
      if (HAS_FILM) { const [g0, g1, gw] = frameAt(st.pos); drawMist(g0, g1, gw); }
      drawDrops();
    }
    // ------------------------------------------------------------ the liquid surface
    // Menisci from capillarity (to scale): the surface climbs the glass (contact angle ~30°)
    // and the ice (~0°) and relaxes over the capillary length lc = sqrt(sigma / rho g), which
    // follows the alcohol content of the top layer. Between them, the surface height from the
    // pressure under the (rigid-lid) surface in the simulation, exaggerated SURF_EXAG times.
    const SURF_EXAG = 12;
    const SIG_A = [0, 0.062, 0.123, 0.24, 0.36], SIG_V = [72.0, 56.4, 48.1, 38.0, 33.0];
    function sigmaOf(abv) {
      let i = 0; while (i < SIG_A.length - 2 && abv > SIG_A[i + 1]) i++;
      const f = Math.min(1, Math.max(0, (abv - SIG_A[i]) / (SIG_A[i + 1] - SIG_A[i])));
      return (SIG_V[i] + (SIG_V[i + 1] - SIG_V[i]) * f) * 1e-3;
    }
    const topRow = new Int16Array(NX).fill(-1);
    for (let c = 0; c < NX; c++) for (let r = 0; r < NY; r++) if (mat[r * NX + c] === 2) { topRow[c] = r; break; }
    // Pose of ice body ib between two stored frames: centre and angle interpolated, then pushed
    // back out of the glass if needed. A piece rolling along the wall between frames would
    // otherwise be drawn partly inside it, which the simulation never allows.
    const ALPHA_W = Math.atan(tanA), CA_W = Math.cos(ALPHA_W), SA_W = Math.sin(ALPHA_W);
    function icePose(ib, f0, f1, w) {
      const b = IB[ib], fr = w < 0.5 ? f0 : f1;
      const p0 = meta.frames[f0].bodies[ib], p1 = meta.frames[f1].bodies[ib];
      const dth = ((p1[2] - p0[2] + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      let x = p0[0] + (p1[0] - p0[0]) * w, y = p0[1] + (p1[1] - p0[1]) * w;
      const th = p0[2] + dth * w;
      if (w > 0 && w < 1) {
        const nC = b.cells, cell = 2 * b.half / nC, cs = Math.cos(th), sn = Math.sin(th);
        for (const side of [-1, 1]) {
          let pen = 0;
          for (let r = 0; r < nC; r++) for (let c = 0; c < nC; c++) {
            if (ICEPX[iat(fr, nC, r, ib * nC + c)] < 77) continue;
            const lx = (c + 0.5) * cell - b.half, ly = b.half - (r + 0.5) * cell;
            const px = x + cs * lx - sn * ly, py = y + sn * lx + cs * ly;
            pen = Math.max(pen, (side * (px - Gm.cx) - (py - Gm.apex_in) * tanA) * CA_W + 0.5 * cell + 0.15);
          }
          if (pen > 0) { x += -side * CA_W * pen; y += SA_W * pen; }
        }
      }
      return { x, y, th, fr };
    }
    const H_MEN = Math.SQRT2 * Math.sqrt(0.038 / (968 * 9.81)) * 1000;   // mm, ~2.8: highest the drink climbs ice
    function waterlines(f0, f1, w) {
      const fr = w < 0.5 ? f0 : f1, out = [];
      IB.forEach((b, ib) => {
        const { x: bx, y: by, th } = icePose(ib, f0, f1, w);
        const nC = b.cells, cell = 2 * b.half / nC, cs = Math.cos(th), sn = Math.sin(th);
        let xl = 1e9, xr = -1e9, area = 0; const pts = [];
        for (let r = 0; r < nC; r++) for (let c = 0; c < nC; c++) {
          const a = ICEPX[iat(fr, nC, r, ib * nC + c)] / 255;
          if (a < 0.3) continue;
          area += a * cell * cell;
          const lx = (c + 0.5) * cell - b.half, ly = b.half - (r + 0.5) * cell;
          const x = bx + cs * lx - sn * ly, y = by + sn * lx + cs * ly;
          pts.push([x, y]);
          // the drink reaches ice up to a meniscus height above the flat level (also under a rim)
          if (y > Gm.fill_y - 1.0 && y <= Gm.fill_y + H_MEN) { xl = Math.min(xl, x); xr = Math.max(xr, x); }
        }
        if (area < 6 || xl > xr) return;
        // freeboard right at each waterline edge: the drink can only climb the ice as high as the
        // ice reaches there (a tipped piece's corner further in must not lift the meniscus)
        let fbl = 0, fbr = 0;
        for (const [x, y] of pts) {
          if (x < xl + cell) fbl = Math.max(fbl, y - Gm.fill_y);
          if (x > xr - cell) fbr = Math.max(fbr, y - Gm.fill_y);
        }
        out.push({ xl, xr, fbl, fbr });
      });
      return out.sort((a, b) => a.xl - b.xl);
    }
    function drawSurface(f0, f1, w) {
      const g = Gm, fy = g.fill_y, hw = (fy - g.apex_in) * tanA;
      // capillary length from the top layer's alcohol content
      let as = 0, an = 0;
      for (let c = 0; c < NX; c++) if (topRow[c] >= 0) { const k = topRow[c] * NX + c; if (FSof(f0, k) < 0.02) { as += ABVof(f0, k); an++; } }
      const lc = Math.sqrt(sigmaOf(an ? as / an : 0.24) / (968 * 9.81)) * 1000;      // mm
      // Meniscus height h = lc sqrt(2 (1 - cos phi)), phi = slope of the surface where it meets the
      // solid. The glass leans outwards (wall at 90° - alpha from horizontal) and the drink meets it
      // at ~30°, so phi = 90° - alpha - 30° (about 20°): only ~0.35 lc. Ice (contact angle 0, near
      // vertical faces): up to sqrt(2) lc, but never above the ice itself.
      const phiG = Math.max(0, Math.PI / 2 - ALPHA_W - Math.PI / 6);
      const hGlass = lc * Math.sqrt(2 * (1 - Math.cos(phiG))), hIce = fb => Math.min(lc * Math.SQRT2, fb);
      const e0 = meta.frames[f0].eta_um, e1 = meta.frames[f1].eta_um;
      const eta = x => {
        if (!e0) return 0;
        const u = Math.min(e0.length - 1.001, Math.max(0, x / CELL - 0.5)), i = Math.floor(u), t = u - i;
        const a = e0[i] * (1 - t) + e0[i + 1] * t, b = e1[i] * (1 - t) + e1[i + 1] * t;
        return (a * (1 - w) + b * w) * 1e-3 * SURF_EXAG;                                 // mm, exaggerated
      };
      // free stretches of surface between the glass and the cubes
      // the drink touches the glass where the wall is at the meniscus height (the wall slopes outwards)
      const xgL = g.cx - (fy + hGlass - g.apex_in) * tanA, xgR = g.cx + (fy + hGlass - g.apex_in) * tanA;
      const segs = []; let xa = xgL, ha = hGlass;
      for (const c of waterlines(f0, f1, w)) {
        if (c.xr < xa || c.xl > xgR) continue;
        if (c.xl > xa) segs.push([xa, ha, c.xl, hIce(c.fbl)]);
        xa = Math.max(xa, c.xr); ha = hIce(c.fbr);
      }
      segs.push([xa, ha, xgR, hGlass]);
      // colour of the liquid just under the surface, column by column
      const d = img.data;
      for (const [x0, h0, x1, h1] of segs) {
        if (x1 - x0 < 0.2) continue;
        const N = Math.max(4, Math.ceil((x1 - x0) / 0.25)), xs = [], ys = [];
        for (let i = 0; i <= N; i++) {
          const x = x0 + (x1 - x0) * i / N;
          // the exaggerated flow height fades out within a capillary length of the ice and the glass,
          // so the menisci meet them at their true height (the real height there is only tens of µm)
          const s = Math.min(1, (x - x0) / lc, (x1 - x) / lc), tap = s * s * (3 - 2 * s);
          ys.push(fy + h0 * Math.exp(-(x - x0) / lc) + h1 * Math.exp(-(x1 - x) / lc) + tap * eta(x)); xs.push(x);
        }
        // liquid above the flat line (menisci, bulges): fill with the colour beneath
        cx.save();
        const xStart = x0 === xgL ? g.cx - hw : xs[0], xEnd = x1 === xgR ? g.cx + hw : xs[N];
        cx.beginPath(); cx.moveTo(X(xStart), Y(fy));
        for (let i = 0; i <= N; i++) cx.lineTo(X(xs[i]), Y(Math.max(ys[i], fy)));
        cx.lineTo(X(xEnd), Y(fy)); cx.closePath();
        const cm = Math.min(NX - 1, Math.max(0, Math.round((x0 + x1) / 2 / CELL)));
        const k = Math.max(0, topRow[cm]) * NX + cm, o = k * 4;
        cx.fillStyle = `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`; cx.fill();
        // dips below the flat line: show the air just above the drink there (clearing the canvas
        // instead would expose the page background as a dark band)
        const ka = Math.max(0, topRow[cm] - 1) * NX + cm, oa = ka * 4;
        cx.fillStyle = `rgb(${d[oa]},${d[oa + 1]},${d[oa + 2]})`;
        cx.beginPath(); cx.moveTo(X(xs[0]), Y(fy));
        for (let i = 0; i <= N; i++) cx.lineTo(X(xs[i]), Y(Math.min(ys[i], fy)));
        cx.lineTo(X(xs[N]), Y(fy)); cx.closePath(); cx.fill();
        cx.restore();
        // the surface itself: a soft sheen and a fine highlight
        cx.save(); cx.lineJoin = 'round'; cx.lineCap = 'round';
        cx.beginPath(); cx.moveTo(X(xs[0]), Y(ys[0])); for (let i = 1; i <= N; i++) cx.lineTo(X(xs[i]), Y(ys[i]));
        cx.strokeStyle = 'rgba(200,225,255,0.16)'; cx.lineWidth = 4; cx.stroke();
        cx.strokeStyle = 'rgba(255,255,255,0.62)'; cx.lineWidth = 0.9; cx.stroke();
        cx.restore();
      }
    }
    // Ice cubes: rigid bodies drawn from their own stored shape, position and angle
    const IB = meta.ice_bodies || [];
    const iceCv = IB.map(b => { const c = document.createElement('canvas'); c.width = b.cells; c.height = b.cells; return c; });
    function drawIce(f0, f1, w) {
      const fr = w < 0.5 ? f0 : f1;                     // shape from the nearest frame
      IB.forEach((b, ib) => {
        const { x, y, th } = icePose(ib, f0, f1, w);
        const nC = b.cells, g = iceCv[ib].getContext('2d'), im = g.createImageData(nC, nC);
        const cellA = (2 * b.half / nC) ** 2;
        let area = 0;
        for (let r = 0; r < nC; r++) for (let c = 0; c < nC; c++) area += ICEPX[iat(fr, nC, r, ib * nC + c)] / 255 * cellA;
        // the last slivers (< ~6 mm²) are numerically jittery: fade them out
        const fade = Math.min(1, Math.max(0, (area - 3) / 5));
        if (fade <= 0) return;
        for (let r = 0; r < nC; r++) for (let c = 0; c < nC; c++) {
          const a = ICEPX[iat(fr, nC, r, ib * nC + c)] / 255, o = (r * nC + c) * 4;
          im.data[o] = 228; im.data[o + 1] = 240; im.data[o + 2] = 255; im.data[o + 3] = Math.min(255, a * 1.15 * 235) * fade;
        }
        g.putImageData(im, 0, 0);
        const size = 2 * b.half * sc;
        cx.save();
        cx.translate(X(x), Y(y)); cx.rotate(-th);
        cx.shadowColor = 'rgba(200,230,255,0.55)'; cx.shadowBlur = 6;
        cx.imageSmoothingEnabled = true;
        cx.drawImage(iceCv[ib], -size / 2, -size / 2, size, size);
        cx.restore();
      });
    }
    // glass body: outer silhouette (bowl, stem, foot) minus the bowl's inside, as one path
    function glassPath() {
      const g = Gm, xo = (g.rim_y - g.apex_out) * tanA;
      cx.beginPath();
      cx.moveTo(X(g.cx - xo), Y(g.rim_y)); cx.lineTo(X(g.cx - 3.2), Y(g.apex_out + 2.5));
      cx.lineTo(X(g.cx - 3.2), Y(22)); cx.quadraticCurveTo(X(g.cx - 5.5), Y(19.5), X(g.cx - 36), Y(19.5));
      cx.lineTo(X(g.cx - 36), Y(15)); cx.lineTo(X(g.cx + 36), Y(15)); cx.lineTo(X(g.cx + 36), Y(19.5));
      cx.quadraticCurveTo(X(g.cx + 5.5), Y(19.5), X(g.cx + 3.2), Y(22)); cx.lineTo(X(g.cx + 3.2), Y(g.apex_out + 2.5));
      cx.lineTo(X(g.cx + xo), Y(g.rim_y)); cx.closePath();
      cx.moveTo(X(g.cx - g.half_rim_in), Y(g.rim_y)); cx.lineTo(X(g.cx), Y(g.apex_in)); cx.lineTo(X(g.cx + g.half_rim_in), Y(g.rim_y)); cx.closePath();
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
      cx.restore();
    }
    // mist: the fine droplets of a fogged glass, as dense as the simulated film (fixed positions per
    // spot along the wall, so they don't flicker)
    const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
    function drawMist(f0, f1, w) {
      if (!HAS_FILM) return;
      for (const side of [-1, 1]) for (const seg of [0, 1]) {
        const L = seg === 0 ? LWALL : STEM_TOP - STEM_BOT;
        let prev = null;
        for (let s = 0, n = 0; s <= L; s += 0.45, n++) {
          const h = wallFilm({ side, seg, s, r: 0 }, f0, f1, w);
          const [xm, ym] = onWall({ side, seg, s, r: 0 });
          // frost: the glass turns milky as the first micrometres condense
          if (prev && h > 0.3) {
            cx.strokeStyle = `rgba(226,238,255,${Math.min(0.55, 0.12 + h / 12)})`; cx.lineWidth = Math.max(1, 0.55 * sc);
            cx.beginPath(); cx.moveTo(X(prev[0] + side * 0.2), Y(prev[1])); cx.lineTo(X(xm + side * 0.2), Y(ym)); cx.stroke();
          }
          prev = [xm, ym];
          if (h < 1) continue;
          const nd = Math.min(5, Math.ceil(h / 2.5));
          cx.fillStyle = 'rgba(232,242,255,0.6)';
          for (let q = 0; q < nd; q++) {
            const a = hash(n * 7 + q, side * 3 + seg), b = hash(q * 13 + n, seg - side);
            const [dx_, dy_] = onWall({ side, seg, s: s + (a - 0.5) * 0.4, r: 0 });
            const rr = (0.12 + 0.3 * b * Math.min(1, h / 12)) * sc;
            cx.beginPath(); cx.arc(X(dx_ + side * (0.25 + 0.45 * a)), Y(dy_), Math.max(0.6, rr), 0, Math.PI * 2); cx.fill();
          }
        }
      }
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
      // air (stored flow, same time-lapse as the drink)
      px.strokeStyle = 'rgba(210,225,250,0.4)'; px.lineWidth = 0.9;
      px.beginPath();
      for (const p of PA) {
        const k = Math.min(NY - 1, p.y | 0) * NX + Math.min(NX - 1, p.x | 0);
        if (mat[k] !== 0 || --p.life < 0) { spawnA(p); continue; }
        const uu = AUof(f0, k) * (1 - w) + AUof(f1, k) * w, vv = AVof(f0, k) * (1 - w) + AVof(f1, k) * w;
        const x2 = p.x + uu / VMAXA * 1.4, y2 = p.y - vv / VMAXA * 1.4;
        px.moveTo(p.x * cs, p.y * cs); px.lineTo(x2 * cs, y2 * cs);
        p.x = x2; p.y = y2;
        if (p.x < 0 || p.y < 0 || p.x >= NX || p.y >= NY) spawnA(p);
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
      if (VP && meta.frames[0].evap_pct !== undefined) {
        const v = lerpStat('evap_pct'), a = lerpStat('ethanol_lost_pct'), lv = lerpStat('level_drop_mm');
        el('ck-evap').textContent = `${v.toFixed(v < 1 ? 2 : 1)} % of the drink · ${a.toFixed(a < 1 ? 2 : 1)} % of its alcohol · level −${lv < 1 ? Math.round(lv * 1000) + ' µm' : lv.toFixed(2) + ' mm'}`;
      }
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
        // playback pace in simulated seconds per second at 1×, whatever the frame spacing
        const f0_ = Math.min(NF - 2, Math.floor(st.pos)), tf = meta.frames[f0_].t;
        const pace = tf < 1200 ? 24 : tf < 3600 ? 48 : tf < 5400 ? 96 : 480;   // slower while the ice lasts
        st.pos += dtw * st.speed * pace / Math.max(1e-6, meta.frames[f0_ + 1].t - tf);
        if (st.pos >= NF - 1) { st.pos = NF - 1; st.playing = false; el('ck-play').textContent = 'Replay'; }
      }
      const [f0, f1, w] = frameAt(st.pos);

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
      el('ck-legend-evap').hidden = st.view !== 'evap';
    }));
    document.querySelectorAll('input[name="ck-speed"]').forEach(r => r.addEventListener('change', e => { st.speed = +e.target.value; }));

    resize();

    el('ck-status').hidden = true;
    start();
    new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop(); }).observe(stage);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : onScreen && start()));
    window.addEventListener('blur', stop);
    window.addEventListener('focus', () => onScreen && start());
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
  }
})();
