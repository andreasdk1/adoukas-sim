// Live demo: forced-air cooling of a power board, solved in the browser.
//
// Flow: 2D incompressible flow on a staggered (MAC) grid over the board, solved
// with semi-Lagrangian advection and a Gauss–Seidel pressure projection, plus a
// Hele-Shaw friction term for the channel walls. Tall parts are solid obstacles.
// Heat: the board is a conducting sheet (copper + FR4) with each part's power as
// a source. It loses heat to the air above through a local convection
// coefficient that depends on the local air speed (laminar flat-plate
// correlation), and to the enclosure below. The air temperature is transported
// by the flow and heated by the board. Junction temperature = board under the
// part + P·R_jb.
(function () {
  'use strict';

  // ---------------------------------------------------------------- geometry
  const BOARD_W = 160, BOARD_H = 100;         // mm
  const NXB = 200, NYB = 125;                 // board cells
  const DX = BOARD_W / NXB / 1000;            // m (0.8 mm)
  const nx = NXB + 1, ny = NYB + 2, n = ny;   // + inlet column, + top/bottom walls
  const N = nx * ny;

  // ----------------------------------------------------------------- physics
  const T_AMB = 25;                           // °C
  const RHO_CP_GAP = 1.2 * 1005 * 0.010;      // air ρ·cp × 10 mm channel gap, J/m²K
  const NU_AIR = 1.6e-5;                      // m²/s
  const H_BOTTOM = 8;                         // W/m²K, underside to enclosure
  const COPPER = {                            // in-plane sheet conductance k·t, W/K
    '1oz2': 2 * 400 * 35e-6 + 0.3 * 1.6e-3,
    '2oz2': 2 * 400 * 70e-6 + 0.3 * 1.6e-3,
    '1oz4': 4 * 400 * 35e-6 + 0.3 * 1.6e-3,
  };
  // Local convection coefficient: laminar flat plate, Nu = 0.664 Re^½ Pr^⅓ over a
  // 50 mm developing length, plus a 6 W/m²K floor for natural convection/radiation.
  const hConv = u => 6 + 17 * Math.sqrt(Math.max(u, 0));

  // Tmax is a conservative design limit, not the datasheet absolute maximum:
  // MOSFETs rated 150–175 °C are held to 110 °C, 105 °C electrolytics to 85 °C for
  // lifetime, the MCU to 85 °C, the inductor to 100 °C, the regulator to 105 °C.
  const PARTS0 = [
    { id: 'L1', kind: 'Inductor',     x: 38,  y: 50, w: 14, h: 14, tall: true,  shape: 'rect',   P: 1.5, Rjb: 4,   Tmax: 100 },
    { id: 'C1', kind: 'Electrolytic', x: 36,  y: 22, w: 10, h: 10, tall: true,  shape: 'circle', P: 0.2, Rjb: 10,  Tmax: 85 },
    { id: 'C2', kind: 'Electrolytic', x: 36,  y: 78, w: 10, h: 10, tall: true,  shape: 'circle', P: 0.2, Rjb: 10,  Tmax: 85 },
    { id: 'Q1', kind: 'MOSFET',       x: 66,  y: 50, w: 10, h: 12, tall: false, shape: 'rect',   P: 4.0, Rjb: 1.5, Tmax: 110 },
    { id: 'Q2', kind: 'MOSFET',       x: 92,  y: 30, w: 10, h: 12, tall: false, shape: 'rect',   P: 4.0, Rjb: 1.5, Tmax: 110 },
    { id: 'U1', kind: 'Regulator',    x: 96,  y: 74, w: 6,  h: 6,  tall: false, shape: 'rect',   P: 1.2, Rjb: 12,  Tmax: 105 },
    { id: 'U2', kind: 'MCU',          x: 128, y: 52, w: 12, h: 12, tall: false, shape: 'rect',   P: 0.5, Rjb: 15,  Tmax: 85 },
  ];
  let parts = PARTS0.map(p => ({ ...p }));

  // ------------------------------------------------------------------- state
  const u = new Float32Array(N), v = new Float32Array(N);
  const nu = new Float32Array(N), nv = new Float32Array(N);
  const s = new Float32Array(N);              // 1 = fluid, 0 = solid
  const Ta = new Float32Array(N).fill(T_AMB), nTa = new Float32Array(N);
  const Tb = new Float32Array(N).fill(T_AMB);
  const q = new Float32Array(N);              // W/m² heat source into the board
  const owner = new Int16Array(N).fill(-1);   // part index per cell
  const hcell = new Float32Array(N);

  const ui = {
    fan: 2.0, copper: '1oz2', view: 'board', selected: 3,
  };
  let Ug = 1;                                 // inlet velocity in cells/step
  let dtp = 1;                                // physical seconds per step
  let residual = 1, isSettled = false;

  // --------------------------------------------------------------- canvases
  const wrap = document.getElementById('demo-stage');
  const cHeat = document.getElementById('demo-heat');
  const cFlow = document.getElementById('demo-flow');
  const cUI = document.getElementById('demo-ui');
  const xHeat = cHeat.getContext('2d'), xFlow = cFlow.getContext('2d'), xUI = cUI.getContext('2d');
  const off = document.createElement('canvas'); off.width = NXB; off.height = NYB;
  const xOff = off.getContext('2d');
  const img = xOff.createImageData(NXB, NYB);
  let W = 0, H = 0, sc = 1, DPR = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    const r = wrap.getBoundingClientRect();
    W = r.width; H = W * BOARD_H / BOARD_W;
    wrap.style.height = H + 'px';
    for (const c of [cHeat, cFlow, cUI]) {
      c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
      c.style.width = W + 'px'; c.style.height = H + 'px';
      c.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    sc = W / BOARD_W;                          // px per mm
  }

  // ------------------------------------------------------------ colour maps
  function lut(stops) {
    const out = new Uint8ClampedArray(256 * 3);
    for (let k = 0; k < 256; k++) {
      const t = k / 255;
      let a = 0; while (a < stops.length - 2 && t > stops[a + 1][0]) a++;
      const [t0, c0] = stops[a], [t1, c1] = stops[a + 1];
      const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
      for (let ch = 0; ch < 3; ch++) out[k * 3 + ch] = c0[ch] + (c1[ch] - c0[ch]) * f;
    }
    return out;
  }
  const THERMAL = lut([[0, [11, 20, 48]], [0.18, [40, 30, 100]], [0.4, [120, 40, 120]], [0.6, [210, 70, 60]], [0.8, [245, 160, 60]], [1, [255, 240, 190]]]);
  const SPEED = lut([[0, [8, 14, 30]], [0.35, [30, 70, 150]], [0.7, [90, 150, 230]], [1, [225, 238, 255]]]);
  const RANGES = { board: [T_AMB, 100], air: [T_AMB, 40] };

  // ---------------------------------------------------------- mask building
  function cellOf(xmm, ymm) { return [Math.floor(xmm / BOARD_W * NXB) + 1, Math.floor(ymm / BOARD_H * NYB) + 1]; }
  function inside(p, xmm, ymm) {
    if (p.shape === 'circle') return (xmm - p.x) ** 2 + (ymm - p.y) ** 2 <= (p.w / 2) ** 2;
    return Math.abs(xmm - p.x) <= p.w / 2 && Math.abs(ymm - p.y) <= p.h / 2;
  }
  function rebuild() {
    hist.length = 0;
    s.fill(1); q.fill(0); owner.fill(-1);
    for (let i = 0; i < nx; i++) { s[i * n] = 0; s[i * n + ny - 1] = 0; }
    for (let j = 0; j < ny; j++) s[j] = 0;   // inlet column
    parts.forEach((p, k) => {
      const [i0, j0] = cellOf(p.x - p.w / 2, p.y - p.h / 2), [i1, j1] = cellOf(p.x + p.w / 2, p.y + p.h / 2);
      const cells = [];
      for (let i = Math.max(1, i0); i <= Math.min(nx - 1, i1); i++)
        for (let j = Math.max(1, j0); j <= Math.min(ny - 2, j1); j++) {
          const xmm = (i - 0.5) * BOARD_W / NXB, ymm = (j - 0.5) * BOARD_H / NYB;
          if (inside(p, xmm, ymm)) cells.push(i * n + j);
        }
      p.cells = cells;
      const qa = cells.length ? p.P / (cells.length * DX * DX) : 0;
      for (const c of cells) {
        owner[c] = k; q[c] += qa;
        if (p.tall) { s[c] = 0; u[c] = 0; v[c] = 0; }
      }
    });
    // zero velocities on faces touching solids
    for (let i = 1; i < nx; i++) for (let j = 1; j < ny - 1; j++) {
      const c = i * n + j;
      if (s[c] === 0 || s[c - n] === 0) u[c] = 0;
      if (s[c] === 0 || s[c - 1] === 0) v[c] = 0;
    }
  }

  // ------------------------------------------------------------- fluid step
  function setInlet() {
    Ug = 0.55 + 0.13 * ui.fan;
    dtp = Ug * DX / ui.fan;
    for (let j = 1; j < ny - 1; j++) { u[n + j] = Ug; v[j] = 0; Ta[j] = T_AMB; Ta[n + j] = T_AMB; }
  }
  function project(iters) {
    const omega = 1.9;
    for (let it = 0; it < iters; it++) {
      for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
        const c = i * n + j;
        if (s[c] === 0) continue;
        const sx0 = s[c - n], sx1 = s[c + n], sy0 = s[c - 1], sy1 = s[c + 1];
        const ss = sx0 + sx1 + sy0 + sy1;
        if (ss === 0) continue;
        const div = u[c + n] - u[c] + v[c + 1] - v[c];
        const p = -div / ss * omega;
        u[c] -= sx0 * p; u[c + n] += sx1 * p; v[c] -= sy0 * p; v[c + 1] += sy1 * p;
      }
    }
  }
  function extrapolate() {
    for (let i = 0; i < nx; i++) { u[i * n] = u[i * n + 1]; u[i * n + ny - 1] = u[i * n + ny - 2]; }
    for (let j = 0; j < ny; j++) { v[j] = v[n + j]; v[(nx - 1) * n + j] = v[(nx - 2) * n + j]; }
  }
  function sample(x, y, f, dx, dy) {
    x = Math.max(Math.min(x, nx), 1); y = Math.max(Math.min(y, ny), 1);
    const x0 = Math.min(Math.floor(x - dx), nx - 1), tx = x - dx - x0, x1 = Math.min(x0 + 1, nx - 1);
    const y0 = Math.min(Math.floor(y - dy), ny - 1), ty = y - dy - y0, y1 = Math.min(y0 + 1, ny - 1);
    return (1 - tx) * (1 - ty) * f[x0 * n + y0] + tx * (1 - ty) * f[x1 * n + y0] + tx * ty * f[x1 * n + y1] + (1 - tx) * ty * f[x0 * n + y1];
  }
  const sampleU = (x, y) => sample(x, y, u, 0, 0.5);
  const sampleV = (x, y) => sample(x, y, v, 0.5, 0);
  function advectVel() {
    nu.set(u); nv.set(v);
    for (let i = 1; i < nx; i++) for (let j = 1; j < ny; j++) {
      const c = i * n + j;
      if (s[c] !== 0 && s[c - n] !== 0 && j < ny - 1) {
        const vv = (v[c - n] + v[c] + v[c - n + 1] + v[c + 1]) * 0.25;
        nu[c] = sampleU(i - u[c], j + 0.5 - vv);
      }
      if (s[c] !== 0 && s[c - 1] !== 0 && i < nx - 1) {
        const uu = (u[c - 1] + u[c] + u[c + n - 1] + u[c + n]) * 0.25;
        nv[c] = sampleV(i + 0.5 - uu, j - v[c]);
      }
    }
    u.set(nu); v.set(nv);
  }
  function viscosity() {
    // Explicit viscous diffusion with no-slip on solid surfaces (ghost value −u),
    // which is what creates boundary layers, wakes and vortex shedding.
    const nuG = 0.045;
    nu.set(u); nv.set(v);
    for (let i = 2; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
      const c = i * n + j;
      if (s[c] !== 0 && s[c - n] !== 0) {
        const uS = (s[c - 1] && s[c - n - 1]) ? u[c - 1] : -u[c];
        const uN = (s[c + 1] && s[c - n + 1]) ? u[c + 1] : -u[c];
        nu[c] = u[c] + nuG * (u[c - n] + u[c + n] + uS + uN - 4 * u[c]);
      }
      if (s[c] !== 0 && s[c - 1] !== 0) {
        const vW = (s[c - n] && s[c - n - 1]) ? v[c - n] : -v[c];
        const vE = (s[c + n] && s[c + n - 1]) ? v[c + n] : -v[c];
        nv[c] = v[c] + nuG * (vW + vE + v[c - 1] + v[c + 1] - 4 * v[c]);
      }
    }
    u.set(nu); v.set(nv);
  }
  function friction() {
    // Hele-Shaw drag from the channel's top and bottom walls: λ = 12ν / gap²
    const k = 1 - Math.min(0.2, 12 * NU_AIR / (0.010 ** 2) * dtp);
    for (let c = 0; c < N; c++) { u[c] *= k; v[c] *= k; }
  }

  // ------------------------------------------------------------ heat step
  function localSpeed(c) {
    const i = (c / n) | 0;
    const uc = i < nx - 1 ? 0.5 * (u[c] + u[c + n]) : u[c];
    const vc = 0.5 * (v[c] + v[c + 1]);
    return Math.hypot(uc, vc) / Ug * ui.fan;  // m/s
  }
  function updateH() {
    const hBody = 2.5 * hConv(0.6 * ui.fan);  // tall body: extra wetted area, partly sheltered
    for (let i = 1; i < nx; i++) for (let j = 1; j < ny - 1; j++) {
      const c = i * n + j;
      hcell[c] = s[c] === 0 ? hBody : hConv(localSpeed(c));
    }
  }
  function advectAir() {
    nTa.set(Ta);
    for (let i = 2; i < nx; i++) for (let j = 1; j < ny - 1; j++) {
      const c = i * n + j;
      if (s[c] === 0) { nTa[c] = 0.25 * (Ta[c - n] + Ta[(i < nx - 1 ? c + n : c)] + Ta[c - 1] + Ta[c + 1]); continue; }
      const uc = i < nx - 1 ? 0.5 * (u[c] + u[c + n]) : u[c], vc = 0.5 * (v[c] + v[c + 1]);
      let t = sample(i + 0.5 - uc, j + 0.5 - vc, Ta, 0.5, 0.5);
      t += dtp * hcell[c] * (Tb[c] - t) / RHO_CP_GAP;
      nTa[c] = t;
    }
    Ta.set(nTa);
  }
  function solveBoard(sweeps) {
    const Gd = COPPER[ui.copper] / (DX * DX), omega = 1.9;
    let maxd = 0;
    for (let sw = 0; sw < sweeps; sw++) {
      for (let color = 0; color < 2; color++) {
        for (let i = 1; i < nx; i++) for (let j = 1 + ((i + color) & 1); j < ny - 1; j += 2) {
          const c = i * n + j;
          let sum = 0, cnt = 0;
          if (i > 1) { sum += Tb[c - n]; cnt++; }
          if (i < nx - 1) { sum += Tb[c + n]; cnt++; }
          if (j > 1) { sum += Tb[c - 1]; cnt++; }
          if (j < ny - 2) { sum += Tb[c + 1]; cnt++; }
          const ht = hcell[c];
          const tn = (Gd * sum + q[c] + ht * Ta[c] + H_BOTTOM * T_AMB) / (Gd * cnt + ht + H_BOTTOM);
          const d = omega * (tn - Tb[c]);
          Tb[c] += d;
          if (sw === sweeps - 1 && Math.abs(d) > maxd) maxd = Math.abs(d);
        }
      }
    }
    return maxd;
  }
  const hist = [];
  // Settled = the trend has stopped, judged on the mean of the hottest junction
  // over the last second vs the second before. Wake shedding makes the
  // instantaneous value wobble, so a max−min test would never pass.
  const WIN = 60;
  function settled() {
    const m = parts.reduce((a, p) => Math.max(a, p.Tj), 0);
    hist.push(m); if (hist.length > 2 * WIN) hist.shift();
    if (hist.length < 2 * WIN) return false;
    let a = 0, b = 0;
    for (let k = 0; k < WIN; k++) { a += hist[k]; b += hist[k + WIN]; }
    return Math.abs(a - b) / WIN < 0.3;
  }
  function junctions() {
    for (const p of parts) {
      let t = 0; for (const c of p.cells) t += Tb[c];
      p.Tb = p.cells.length ? t / p.cells.length : T_AMB;
      p.Tj = p.Tb + p.P * p.Rjb;
      p.TjS = p.TjS === undefined ? p.Tj : p.TjS + 0.08 * (p.Tj - p.TjS);   // smoothed for display
    }
  }

  // ------------------------------------------------------------- particles
  const NP = 900;
  const P = Array.from({ length: NP }, () => spawn({}, true));
  function spawn(p, anywhere) {
    p.x = anywhere ? 1 + Math.random() * (nx - 2) : 1 + Math.random() * 3;
    p.y = 1 + Math.random() * (ny - 2);
    p.life = 200 + Math.random() * 400;
    return p;
  }
  function moveParticles(steps) {
    const k = sc * BOARD_W / NXB;             // px per cell
    xFlow.globalCompositeOperation = 'destination-out';
    xFlow.fillStyle = 'rgba(0,0,0,0.09)';
    xFlow.fillRect(0, 0, W, H);
    xFlow.globalCompositeOperation = 'source-over';
    xFlow.strokeStyle = ui.view === 'speed' ? 'rgba(8,14,30,0.5)' : 'rgba(235,242,255,0.32)';
    xFlow.lineWidth = 1;
    xFlow.beginPath();
    for (const p of P) {
      const ux = sampleU(p.x, p.y), vy = sampleV(p.x, p.y);
      const x2 = p.x + ux * steps, y2 = p.y + vy * steps;
      xFlow.moveTo((p.x - 1) * k, (p.y - 1) * k); xFlow.lineTo((x2 - 1) * k, (y2 - 1) * k);
      p.x = x2; p.y = y2;
      const c = (Math.floor(p.x) * n + Math.floor(p.y)) | 0;
      if (--p.life < 0 || p.x >= nx - 1 || p.x < 1 || p.y < 1 || p.y >= ny - 1 || s[c] === 0) spawn(p, Math.random() < 0.3);
    }
    xFlow.stroke();
  }

  // ------------------------------------------------------------- rendering
  function drawField() {
    const d = img.data;
    let f, map, lo, hi;
    if (ui.view === 'speed') { map = SPEED; lo = 0; hi = 1.6 * ui.fan; }
    else if (ui.view === 'air') { f = Ta; map = THERMAL; [lo, hi] = RANGES.air; }
    else { f = Tb; map = THERMAL; [lo, hi] = RANGES.board; }
    for (let jb = 0; jb < NYB; jb++) for (let ib = 0; ib < NXB; ib++) {
      const c = (ib + 1) * n + jb + 1;
      const val = ui.view === 'speed' ? (s[c] === 0 ? 0 : localSpeed(c)) : f[c];
      const k = Math.max(0, Math.min(255, ((val - lo) / (hi - lo) * 255) | 0)) * 3;
      const o = (jb * NXB + ib) * 4;
      d[o] = map[k]; d[o + 1] = map[k + 1]; d[o + 2] = map[k + 2]; d[o + 3] = 255;
    }
    xOff.putImageData(img, 0, 0);
    xHeat.imageSmoothingEnabled = true;
    xHeat.imageSmoothingQuality = 'high';
    xHeat.drawImage(off, 0, 0, W, H);
  }
  function drawParts() {
    xUI.clearRect(0, 0, W, H);
    // fan arrows on the inlet edge
    xUI.fillStyle = 'rgba(169,192,234,0.55)';
    for (let k = 1; k < 6; k++) {
      const y = H * k / 6;
      xUI.beginPath(); xUI.moveTo(4, y - 5); xUI.lineTo(13, y); xUI.lineTo(4, y + 5); xUI.fill();
    }
    xUI.font = `500 ${Math.max(10, Math.min(12.5, W / 70))}px "JetBrains Mono", monospace`;
    xUI.textAlign = 'center'; xUI.textBaseline = 'middle';
    parts.forEach((p, k) => {
      const x = p.x * sc, y = p.y * sc, w = p.w * sc, h = p.h * sc;
      const over = p.TjS > p.Tmax, sel = k === ui.selected;
      xUI.lineWidth = sel ? 2 : 1.2;
      xUI.strokeStyle = over ? '#ff6b5a' : sel ? '#ffffff' : 'rgba(232,238,251,0.75)';
      xUI.fillStyle = p.tall ? 'rgba(18,24,44,0.88)' : 'rgba(0,0,0,0)';
      xUI.beginPath();
      if (p.shape === 'circle') xUI.arc(x, y, w / 2, 0, Math.PI * 2);
      else xUI.rect(x - w / 2, y - h / 2, w, h);
      xUI.fill(); xUI.stroke();
      if (p.tall) {                            // body texture so tall parts read as 3D
        xUI.strokeStyle = 'rgba(169,192,234,0.35)'; xUI.lineWidth = 1;
        xUI.beginPath();
        if (p.shape === 'circle') { xUI.arc(x, y, w / 2 - 3, 0, Math.PI * 2); }
        else { xUI.rect(x - w / 2 + 3, y - h / 2 + 3, w - 6, h - 6); }
        xUI.stroke();
      }
      const label = `${p.id} ${Math.round(p.TjS)}°C`;
      const ty = y + h / 2 + 11;
      const tw = xUI.measureText(label).width + 10;
      xUI.fillStyle = over ? 'rgba(160,30,20,0.9)' : 'rgba(8,14,30,0.78)';
      xUI.fillRect(x - tw / 2, ty - 8, tw, 16);
      xUI.fillStyle = over ? '#fff' : '#e8eefb';
      xUI.fillText(label, x, ty + 0.5);
    });
  }

  // -------------------------------------------------------------- readouts
  const el = id => document.getElementById(id);
  function buildList() {
    el('demo-parts').innerHTML = parts.map((p, k) => `<li data-k="${k}">
        <span class="pid">${p.id}</span><span class="pk">${p.kind}</span>
        <span class="pt"></span><span class="bar"><i></i></span></li>`).join('');
  }
  function renderPanel() {
    const items = el('demo-parts').children;
    parts.forEach((p, k) => {
      const li = items[k]; if (!li) return;
      const over = p.TjS > p.Tmax;
      li.classList.toggle('sel', k === ui.selected);
      li.classList.toggle('over', over);
      li.querySelector('.pt').textContent = `${Math.round(p.TjS)} / ${p.Tmax} °C`;
      li.querySelector('.bar i').style.width = (Math.min(1, Math.max(0, (p.TjS - T_AMB) / (p.Tmax - T_AMB))) * 100).toFixed(1) + '%';
    });
    const sp = parts[ui.selected];
    el('sel-name').textContent = `${sp.id} · ${sp.kind}`;
    if (document.activeElement !== el('sel-power')) el('sel-power').value = sp.P;
    el('sel-power-v').textContent = sp.P.toFixed(1) + ' W';
    const hot = parts.reduce((a, b) => (b.TjS - b.Tmax > a.TjS - a.Tmax ? b : a));
    const total = parts.reduce((a, p) => a + p.P, 0);
    const busy = !isSettled;
    const st = el('demo-status');
    st.className = 'demo-status ' + (busy ? 'busy' : hot.TjS > hot.Tmax ? 'bad' : 'ok');
    st.textContent = busy ? 'Solving…'
      : hot.TjS > hot.Tmax ? `${hot.id} over its design limit by ${Math.round(hot.TjS - hot.Tmax)} °C`
      : `All parts within limits · tightest: ${hot.id}, ${Math.round(hot.Tmax - hot.TjS)} °C margin`;
    el('demo-total').textContent = total.toFixed(1) + ' W total';
  }
  let panelTick = 0;

  // ----------------------------------------------------------------- loop
  let running = false, raf = 0;
  function frame() {
    setInlet();
    for (let k = 0; k < 2; k++) {
      friction();
      viscosity();
      project(30);
      extrapolate();
      advectVel();
      setInlet();
    }
    updateH();
    for (let k = 0; k < 3; k++) advectAir();
    residual = solveBoard(12);
    junctions();
    isSettled = settled();
    drawField();
    moveParticles(2);
    drawParts();
    if (++panelTick % 6 === 0) renderPanel();
    if (running) raf = requestAnimationFrame(frame);
  }
  function start() { if (!running) { running = true; raf = requestAnimationFrame(frame); } }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // ------------------------------------------------------------ interaction
  let drag = null;
  function toMM(e) {
    const r = cUI.getBoundingClientRect();
    return [(e.clientX - r.left) / sc, (e.clientY - r.top) / sc];
  }
  function pick(xmm, ymm) {
    for (let k = parts.length - 1; k >= 0; k--) {
      const p = parts[k];
      if (Math.abs(xmm - p.x) <= p.w / 2 + 2 && Math.abs(ymm - p.y) <= p.h / 2 + 2) return k;
    }
    return -1;
  }
  function collides(k, x, y) {
    const p = parts[k], gap = 1;
    return parts.some((o, m) => m !== k &&
      Math.abs(x - o.x) < (p.w + o.w) / 2 + gap &&
      Math.abs(y - o.y) < (p.h + o.h) / 2 + gap);
  }
  cUI.addEventListener('pointerdown', e => {
    const [x, y] = toMM(e), k = pick(x, y);
    if (k < 0) return;
    e.preventDefault();
    try { cUI.setPointerCapture(e.pointerId); } catch (_) {}
    ui.selected = k;
    drag = { k, dx: x - parts[k].x, dy: y - parts[k].y };
    cUI.style.cursor = 'grabbing';
    renderPanel();
  });
  cUI.addEventListener('pointermove', e => {
    const [x, y] = toMM(e);
    if (!drag) { cUI.style.cursor = pick(x, y) >= 0 ? 'grab' : 'default'; return; }
    const p = parts[drag.k];
    const tx = Math.min(BOARD_W - p.w / 2 - 1, Math.max(p.w / 2 + 6, x - drag.dx));
    const ty = Math.min(BOARD_H - p.h / 2 - 1, Math.max(p.h / 2 + 1, y - drag.dy));
    // Move as far as possible without overlapping another part (1 mm clearance);
    // if the direct move collides, slide along one axis instead.
    const ox = p.x, oy = p.y;
    for (const [cx, cy] of [[tx, ty], [tx, oy], [ox, ty]]) {
      if (!collides(drag.k, cx, cy)) { p.x = cx; p.y = cy; break; }
    }
    if (p.x !== ox || p.y !== oy) rebuild();
  });
  const endDrag = () => { if (drag) { drag = null; cUI.style.cursor = 'grab'; } };
  cUI.addEventListener('pointerup', endDrag);
  cUI.addEventListener('pointercancel', endDrag);
  cUI.addEventListener('touchstart', e => {
    const t = e.touches[0]; if (t && pick(...toMM(t)) >= 0) e.preventDefault();
  }, { passive: false });

  el('fan').addEventListener('input', e => { ui.fan = +e.target.value; hist.length = 0; el('fan-v').textContent = ui.fan.toFixed(1) + ' m/s'; });
  el('copper').addEventListener('change', e => { ui.copper = e.target.value; hist.length = 0; });
  document.querySelectorAll('input[name="view"]').forEach(r => r.addEventListener('change', e => {
    ui.view = e.target.value;
    el('legend-board').hidden = ui.view !== 'board';
    el('legend-air').hidden = ui.view !== 'air';
    el('legend-speed').hidden = ui.view !== 'speed';
    xFlow.clearRect(0, 0, W, H);
  }));
  el('sel-power').addEventListener('input', e => {
    parts[ui.selected].P = +e.target.value;
    el('sel-power-v').textContent = (+e.target.value).toFixed(1) + ' W';
    rebuild();
  });
  el('demo-parts').addEventListener('click', e => {
    const li = e.target.closest('li'); if (!li) return;
    ui.selected = +li.dataset.k; renderPanel();
  });
  el('demo-reset').addEventListener('click', () => {
    parts = PARTS0.map(p => ({ ...p }));
    ui.selected = 3; rebuild(); junctions(); buildList(); renderPanel();
  });

  // ------------------------------------------------------------------ init
  resize();
  rebuild();
  setInlet();
  for (let c = 0; c < N; c++) if (s[c] !== 0) u[c] = Ug;
  // warm start: settle the flow and the board before the first paint
  for (let k = 0; k < 120; k++) { friction(); viscosity(); project(30); extrapolate(); advectVel(); setInlet(); }
  for (let k = 0; k < 40; k++) { updateH(); advectAir(); advectAir(); advectAir(); solveBoard(25); }
  junctions(); buildList(); renderPanel();
  frame();
  let onScreen = true;
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; onScreen ? start() : stop(); }).observe(wrap);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : onScreen && start()));
  window.addEventListener('blur', stop);
  window.addEventListener('focus', () => onScreen && start());
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); xFlow.clearRect(0, 0, W, H); }, 150); });
})();
