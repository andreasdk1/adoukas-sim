// 3D view of the via-array case: board heat map, component, vias and enclosure, drawn to
// scale with an orthographic camera on a plain 2D canvas (planes are affine images, so the
// heat map is drawn with one transform). Heat leaves as particles whose spawn density
// follows the solved local flux: convection plumes, radiation streaks and spreading in the
// copper. Drag to rotate, double-click to reset.
(function () {
  'use strict';
  const STOPS = [[34, 38, 96], [62, 36, 120], [120, 40, 120], [210, 70, 60], [245, 160, 60], [255, 240, 190]];
  function ramp(t) {
    t = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(t)), u = t - i, a = STOPS[i], b = STOPS[i + 1];
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }
  const rgb = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a === undefined ? 1 : a})`;
  const mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
  const YAW0 = -32 * Math.PI / 180, PITCH0 = 30 * Math.PI / 180;
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    let DPR = Math.min(window.devicePixelRatio || 1, 2), CW = 0, CH = 0;
    let yaw = YAW0, pitch = PITCH0, zoom = 1, mode = 'all', clock = 0;
    let g = null;                      // geometry + data of the current case
    let parts = [];
    let running = false, visible = true, active = true, last = 0, raf = 0;

    // ------------------------------------------------------------ camera
    let S = 1, cx0 = 0, cy0 = 0, zc = 0, cyw = 1, syw = 0, cp = 1, sp = 0;
    function camera() {
      cyw = Math.cos(yaw); syw = Math.sin(yaw); cp = Math.cos(pitch); sp = Math.sin(pitch);
      // scale from a fixed reference sphere, so the board's size on screen follows its real size
      // fit a reference box (at least 40 mm, else the board) as seen from the default angle; the
      // scale is then fixed while rotating, and a larger board is drawn larger
      const ref = Math.max(g.W, g.H, 40), zext = g.zTop - g.zBot;
      const cy0r = Math.cos(YAW0), sy0r = Math.sin(YAW0), cp0 = Math.cos(PITCH0), sp0 = Math.sin(PITCH0);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const X of [-ref / 2, ref / 2]) for (const Y of [-ref / 2, ref / 2]) for (const Z of [-zext / 2, zext / 2]) {
        const xs = X * cy0r - Y * sy0r, ys = Z * cp0 + (X * sy0r + Y * cy0r) * sp0;
        x0 = Math.min(x0, xs); x1 = Math.max(x1, xs); y0 = Math.min(y0, ys); y1 = Math.max(y1, ys);
      }
      S = zoom * 0.9 * Math.min(CW / (x1 - x0), CH / (y1 - y0));
      zc = 0.5 * (g.zTop + g.zBot) / zoom;            // zooming in closes on the component
      cx0 = CW / 2; cy0 = CH / 2 + CH * 0.02;
    }
    const P = (x, y, z) => {
      const x1 = x * cyw - y * syw, y1 = x * syw + y * cyw, zz = z - zc;
      return [cx0 + S * x1, cy0 - S * (zz * cp + y1 * sp), y1 * cp - zz * sp];
    };
    function plane(z) {   // world (x, y) on plane z -> screen, as a canvas transform
      const o = P(0, 0, z);
      ctx.setTransform(DPR * S * cyw, DPR * -S * sp * syw, DPR * -S * syw, DPR * -S * sp * cyw, DPR * o[0], DPR * o[1]);
    }
    const screen = () => ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    function resize() {
      const r = canvas.getBoundingClientRect();
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      CW = r.width; CH = r.height;
      canvas.width = Math.round(CW * DPR); canvas.height = Math.round(CH * DPR);
      if (g) draw();
    }

    // ------------------------------------------------------------ data
    function heatImage(T, nx, ny, lo, hi) {
      const off = document.createElement('canvas'); off.width = nx; off.height = ny;
      const ox = off.getContext('2d'), img = ox.createImageData(nx, ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = ramp((T[j * nx + i] - lo) / (hi - lo)), p = ((ny - 1 - j) * nx + i) * 4;
        img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
      }
      ox.putImageData(img, 0, 0);
      return off;
    }
    function cdf(q) {
      const c = new Float64Array(q.length); let s = 0;
      for (let i = 0; i < q.length; i++) { s += Math.max(0, q[i]); c[i] = s; }
      return { c, total: s };
    }
    function pick(d) {
      const r = Math.random() * d.total, c = d.c;
      let lo = 0, hi = c.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] < r) lo = m + 1; else hi = m; }
      return lo;
    }

    function update(s, lo, hi) {
      const o = s.o, mm = 1e3, up = o.side === 'top';
      const W = o.boardW * mm, H = o.boardH * mm, tb = o.tb * mm;
      const enc = !!o.enclosure;
      const gapUp = enc ? o.gapUp * mm : 25, gapDn = enc ? o.gapDn * mm : 25;
      const zU = tb / 2, zL = -tb / 2;
      const upper = up ? s.Tcomp : s.Tfree, lower = up ? s.Tfree : s.Tcomp;
      const Ac = s.dx * s.dy;
      const a = s.arr;
      const vias = [];
      if (a) {
        const x0 = -(a.m - 1) * a.pitch * mm / 2, y0 = -(a.n - 1) * a.pitch * mm / 2;
        for (let i = 0; i < a.m; i++) for (let j = 0; j < a.n; j++) vias.push([x0 + i * a.pitch * mm, y0 + j * a.pitch * mm]);
      }
      const qUc = up ? s.qConvC : s.qConvF, qUr = up ? s.qRadC : s.qRadF;
      const qLc = up ? s.qConvF : s.qConvC, qLr = up ? s.qRadF : s.qRadC;
      g = {
        s, o, up, W, H, tb, enc, zU, zL, zLid: zU + gapUp, zFloor: zL - gapDn,
        zTop: zU + gapUp, zBot: zL - gapDn, lo, hi,
        imgU: heatImage(upper, s.nx, s.ny, lo, hi), imgL: heatImage(lower, s.nx, s.ny, lo, hi),
        TU: upper, TL: lower,
        body: Math.max(o.bodyW, o.arrW) * mm, bodyT: o.bodyT * mm, arrW: o.arrW * mm, arrH: o.arrH * mm,
        vias, viaD: a ? a.d * mm : 0, padD: a ? a.pad * mm : 0, plating: o.plating * mm,
        src: {
          convU: cdf(qUc), radU: cdf(qUr), convL: cdf(qLc), radL: cdf(qLr),
        },
        Ac,
      };
      // copper connected to the array on each face: half extents (mm) and how far it spreads heat
      const ext = m => (m === 'plane' ? [W / 2, H / 2] : m === 'margin' ? [g.arrW / 2 + o.cuMargin * mm, g.arrH / 2 + o.cuMargin * mm] : [g.arrW / 2, g.arrH / 2]);
      const reach = { plane: 1, margin: 0.5, pad: 0.05 };
      g.cuC = { mode: o.cuComp, ext: ext(o.cuComp) }; g.cuF = { mode: o.cuFree, ext: ext(o.cuFree) };
      g.spreadC = reach[o.cuComp] / (reach[o.cuComp] + reach[o.cuFree]);
      g.rate = {
        convU: g.src.convU.total * Ac, radU: g.src.radU.total * Ac, convL: g.src.convL.total * Ac, radL: g.src.radL.total * Ac,
        pkg: Math.max(0, s.Ptop), spread: Math.max(0, s.Pboard),
      };
      buildRadiation(qUr, qLr);
      if (!running) draw();
    }

    // ------------------------------------------------------------ radiation layers
    // Emission: a glow over each face whose strength follows the solved net radiative flux
    // per cell (W/m²); the open via pads are dimmed by their lower emissivity. Reception: the
    // irradiance on the lid and the floor from every board cell and the package top, by the
    // view factor of a small diffuse emitter to a parallel plane, dG = Q h² / (π r⁴). The
    // sources are the solver's own watts, so the received total cannot exceed what is emitted.
    const SIG = 5.670374e-8, GLOW = [255, 236, 190];
    function buildRadiation(qU, qL) {
      const s = g.s, o = g.o, mm = 1e3;
      const Twc = (g.up ? s.TwallC : s.TwallF), Twf = (g.up ? s.TwallF : s.TwallC);   // lid, floor
      const Tk = s.Tpkg + 273.15, TwPkg = (g.up ? Twc : Twf) + 273.15;
      const ePP = 1 / (1 / 0.9 + 1 / 0.9 - 1);
      g.qPkg = Math.max(0, ePP * SIG * (Tk ** 4 - TwPkg ** 4));
      let qmax = g.qPkg;
      for (let i = 0; i < qU.length; i++) qmax = Math.max(qmax, qU[i], qL[i]);
      g.qmax = qmax || 1;
      // brightness rises steeply with flux so the hot region stands out against the rest of the board
      const alphaOf = q => 0.6 * Math.pow(Math.max(0, q) / g.qmax, 2.2);
      const openFree = o.via === 'open';
      g.glowU = glowImage(qU, alphaOf, openFree && g.up === false);   // upper face is the free side when the part is below
      g.glowL = glowImage(qL, alphaOf, openFree && g.up === true);
      g.pkgAlpha = alphaOf(g.qPkg);
      // wall irradiance
      g.irrLid = g.irrFloor = g.irrSides = g.radTotals = null;
      if (g.enc) {
        const srcU = sources(qU, g.zU), srcL = sources(qL, g.zL);
        const pkgSrc = [0, 0, g.up ? g.zU + g.bodyT : g.zL - g.bodyT, g.qPkg * (g.body / mm) ** 2];
        (g.up ? srcU : srcL).push(pkgSrc);
        const lid = wallField(srcU, g.zLid), floor = wallField(srcL, g.zFloor);
        const sides = sideFields(srcU, srcL);
        // one brightness scale for every wall, so their relative brightness is right
        let gmax = 0;
        for (const f of [lid, floor, ...sides]) for (const v of f.G) gmax = Math.max(gmax, v);
        const level = 0.55 * Math.min(1, Math.sqrt(gmax / g.qmax) * 1.4);
        for (const f of [lid, floor, ...sides]) f.img = fieldImage(f, gmax, level);
        g.irrLid = lid; g.irrFloor = floor; g.irrSides = sides;
        let emitU = 0, emitL = 0;
        for (const v of srcU) emitU += v[3];
        for (const v of srcL) emitL += v[3];
        g.radTotals = { emitU, emitL, lid: lid.received, floor: floor.received,
          sidesU: sides.reduce((a, f) => a + f.recU, 0), sidesL: sides.reduce((a, f) => a + f.recL, 0) };
      }
    }
    // irradiance field on a horizontal wall (lid or floor) at height zw, W/m²
    function wallField(src, zw) {
      const nwx = 56, nwy = Math.max(8, Math.round(56 * g.H / g.W));
      const G = new Float64Array(nwx * nwy), Aw = (g.W / nwx) * (g.H / nwy) * 1e-6;
      const a2 = ((src.blk || 0) * 1e-3) ** 2 * 0.5;
      let total = 0;
      for (let r = 0; r < nwy; r++) for (let i = 0; i < nwx; i++) {
        const x = -g.W / 2 + (i + 0.5) * g.W / nwx, y = g.H / 2 - (r + 0.5) * g.H / nwy;
        let v = 0;
        for (const [sx, sy, sz, Q] of src) {
          const h = Math.abs(zw - sz) * 1e-3, dx = (x - sx) * 1e-3, dy = (y - sy) * 1e-3;
          const r2 = dx * dx + dy * dy + h * h + a2;
          v += Q * h * h / (Math.PI * r2 * r2);
        }
        G[r * nwx + i] = v; total += v * Aw;
      }
      return { G, nu: nwx, nv: nwy, received: total };
    }
    // irradiance on the four side walls from both faces (each face sees only its own side of the
    // board). Small emitter with normal ±z to a vertical receiver: dG = Q |Δz| d⊥ / (π r⁴).
    function sideFields(srcU, srcL) {
      const out = [];
      const nv = 40;
      const a2 = ((Math.max(srcU.blk || 0, srcL.blk || 0)) * 1e-3) ** 2 * 0.5;
      for (const [axis, sign] of [['x', 1], ['x', -1], ['y', 1], ['y', -1]]) {
        const len = axis === 'x' ? g.H : g.W, nu = Math.max(8, Math.round(40 * len / Math.max(g.W, g.H)));
        const Xw = (axis === 'x' ? g.W : g.H) / 2 * sign;
        const G = new Float64Array(nu * nv);
        const dA = (len / nu) * ((g.zLid - g.zFloor) / nv) * 1e-6;
        let recU = 0, recL = 0;
        for (let r = 0; r < nv; r++) for (let i = 0; i < nu; i++) {
          const u = -len / 2 + (i + 0.5) * len / nu, z = g.zLid - (r + 0.5) * (g.zLid - g.zFloor) / nv;
          let vU = 0, vL = 0;
          for (const [list, nz] of [[srcU, 1], [srcL, -1]]) for (const [sx, sy, sz, Q] of list) {
            const dz = (z - sz) * nz;
            if (dz <= 0) continue;
            const sw = axis === 'x' ? sx : sy, su = axis === 'x' ? sy : sx;
            const dp = Math.abs(Xw - sw) * 1e-3, du = (u - su) * 1e-3, dzm = dz * 1e-3;
            const r2 = dp * dp + du * du + dzm * dzm + a2;
            const v = Q * dzm * dp / (Math.PI * r2 * r2);
            if (nz > 0) vU += v; else vL += v;
          }
          G[r * nu + i] = vU + vL; recU += vU * dA; recL += vL * dA;
        }
        out.push({ axis, sign, G, nu, nv, len, recU, recL, received: recU + recL });
      }
      return out;
    }
    function fieldImage(f, gmax, level) {
      const c = document.createElement('canvas'); c.width = f.nu; c.height = f.nv;
      const cx = c.getContext('2d'), img = cx.createImageData(f.nu, f.nv);
      for (let k = 0; k < f.G.length; k++) {
        const p = k * 4;
        img.data[p] = GLOW[0]; img.data[p + 1] = GLOW[1]; img.data[p + 2] = GLOW[2];
        img.data[p + 3] = 255 * level * Math.pow(f.G[k] / (gmax || 1), 1.6);
      }
      cx.putImageData(img, 0, 0);
      f.gmax = gmax; f.level = level;
      return c;
    }
    function drawSideGlow(far) {
      if (!g.enc || !g.irrSides || mode === 'conv') return;
      for (const f of g.irrSides) {
        const n = f.axis === 'x' ? [f.sign, 0, 0] : [0, f.sign, 0];
        const isNear = faceVisible(n);
        if (isNear === far) continue;
        const Xw = (f.axis === 'x' ? g.W : g.H) / 2 * f.sign;
        const pt = (u, z) => (f.axis === 'x' ? P(Xw, u, z) : P(u, Xw, z));
        const O = pt(-f.len / 2, g.zLid), A = pt(f.len / 2, g.zLid), B = pt(-f.len / 2, g.zFloor);
        ctx.setTransform(DPR * (A[0] - O[0]) / f.nu, DPR * (A[1] - O[1]) / f.nu, DPR * (B[0] - O[0]) / f.nv, DPR * (B[1] - O[1]) / f.nv, DPR * O[0], DPR * O[1]);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = shimmer(0.9) * (far ? 1 : 0.45);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(f.img, 0, 0);
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      }
      screen();
    }
    function glowImage(q, alphaOf, cutPads) {
      const s = g.s, nx = s.nx, ny = s.ny;
      const small = document.createElement('canvas'); small.width = nx; small.height = ny;
      const sx = small.getContext('2d'), img = sx.createImageData(nx, ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const p = ((ny - 1 - j) * nx + i) * 4;
        img.data[p] = GLOW[0]; img.data[p + 1] = GLOW[1]; img.data[p + 2] = GLOW[2];
        img.data[p + 3] = 255 * alphaOf(q[j * nx + i]);
      }
      sx.putImageData(img, 0, 0);
      const ppm = Math.min(8, 900 / Math.max(g.W, g.H));
      const big = document.createElement('canvas'); big.width = Math.round(g.W * ppm); big.height = Math.round(g.H * ppm);
      const bx = big.getContext('2d');
      bx.imageSmoothingEnabled = true;
      bx.drawImage(small, 0, 0, big.width, big.height);
      if (cutPads && g.vias.length) {
        // bare finish (ε ≈ 0.1) instead of mask (ε ≈ 0.9) on each via pad; the open hole is a cavity (ε ≈ 0.8)
        const X = x => (x + g.W / 2) * ppm, Y = y => (g.H / 2 - y) * ppm;
        const rP = (g.padD / 2 + 0.05) * ppm, rH = Math.max(0.02, g.viaD / 2 - g.plating) * ppm;
        bx.globalCompositeOperation = 'destination-out';
        bx.fillStyle = `rgba(0,0,0,${1 - 0.1 / 0.9})`;
        for (const [x, y] of g.vias) { bx.beginPath(); bx.arc(X(x), Y(y), rP, 0, 6.283); bx.fill(); }
        bx.globalCompositeOperation = 'source-over';
        const cA = alphaOf(q[((s.ny / 2) | 0) * nx + ((nx / 2) | 0)]) * 0.8 / 0.9;
        bx.fillStyle = `rgba(${GLOW[0]},${GLOW[1]},${GLOW[2]},${cA})`;
        for (const [x, y] of g.vias) { bx.beginPath(); bx.arc(X(x), Y(y), rH, 0, 6.283); bx.fill(); }
      }
      return { img: big, ppm };
    }
    function sources(q, z) {           // coarsened board cells as point sources [x, y, z, W]
      const s = g.s, b = Math.max(1, Math.round(s.nx / 50)), out = [];
      const Ac = s.dx * s.dy;
      for (let j0 = 0; j0 < s.ny; j0 += b) for (let i0 = 0; i0 < s.nx; i0 += b) {
        let Q = 0, xs = 0, ys = 0, n = 0;
        for (let j = j0; j < Math.min(s.ny, j0 + b); j++) for (let i = i0; i < Math.min(s.nx, i0 + b); i++) {
          Q += Math.max(0, q[j * s.nx + i]) * Ac; xs += i; ys += j; n++;
        }
        if (Q > 0) out.push([-g.W / 2 + (xs / n + 0.5) * s.dx * 1e3, -g.H / 2 + (ys / n + 0.5) * s.dy * 1e3, z, Q]);
      }
      // each block emits from its whole area, not from a point: spread it over a core of the block's
      // size (r² + a²), which removes the near-field spikes on walls next to the board edge
      out.blk = b * Math.max(s.dx, s.dy) * 1e3;
      return out;
    }
    function shimmer(lag) { return REDUCED ? 1 : 0.86 + 0.14 * Math.sin(1.6 * clock - lag); }
    // in 'All' the glow on the board is kept light so the temperature colours stay saturated;
    // the Radiation view shows it at full strength
    const boardGlow = () => (mode === 'rad' ? 1 : 0.4);
    function drawGlow(z, layer, lag, k = 1) {
      if (!layer || mode === 'conv') return;
      plane(z);
      ctx.transform(g.W / layer.img.width, 0, 0, -g.H / layer.img.height, -g.W / 2, g.H / 2);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, shimmer(lag) * k);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(layer.img, 0, 0);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      screen();
    }

    // ------------------------------------------------------------ particles
    // world units mm, time s
    const PER_W = 110, MAXP = 1200;
    function cellXY(c) {
      const s = g.s, i = c % s.nx, j = (c / s.nx) | 0;
      return [-g.W / 2 + (i + Math.random()) * s.dx * 1e3, -g.H / 2 + (j + Math.random()) * s.dy * 1e3];
    }
    function spawn(dt) {
      if (!g || parts.length > MAXP) return;
      if (mode === 'rad') return;
      const R = g.rate, k = PER_W * dt;
      const emit = (w, fn) => { let n = w * k; while (n > 0) { if (Math.random() < n) fn(); n -= 1; } };
      const T = (arr, c) => arr[c];
      emit(R.convU, () => { const c = pick(g.src.convU), [x, y] = cellXY(c); parts.push({ k: 'cu', x, y, z: g.zU + 0.2, t: 0, life: 2.6 + Math.random(), T: T(g.TU, c), ph: Math.random() * 6.3 }); });
      emit(R.convL, () => { const c = pick(g.src.convL), [x, y] = cellXY(c); parts.push({ k: 'cl', x, y, z: g.zL - 0.2, t: 0, life: 2.6 + Math.random(), T: T(g.TL, c), ph: Math.random() * 6.3 }); });
      emit(R.pkg, () => {
        const b = g.body, zt = g.up ? g.zU + g.bodyT : g.zL - g.bodyT;
        parts.push({ k: g.up ? 'cu' : 'cl', x: (Math.random() - 0.5) * b, y: (Math.random() - 0.5) * b, z: zt, t: 0, life: 2.4, T: g.s.Tpkg, ph: Math.random() * 6.3 });
      });
      // spreading through the copper, outwards from the pad, on the face(s) whose copper spreads it;
      // a dot stops at the edge of the connected copper
      emit(R.spread * 0.8, () => {
        const comp = Math.random() < g.spreadC, cu = comp ? g.cuC : g.cuF;
        const ang = Math.random() * 6.283, r0 = comp ? g.body * 0.55 : Math.max(g.arrW, g.arrH) * 0.5;
        const onUpper = comp === g.up, z = onUpper ? g.zU + 0.05 : g.zL - 0.05;
        parts.push({ k: 'sp', x: Math.cos(ang) * r0, y: Math.sin(ang) * r0, z, vx: Math.cos(ang), vy: Math.sin(ang), t: 0, life: 1.2 + Math.random() * 0.8, T: g.hi,
          ex: Math.max(cu.ext[0], r0 * 1.02), ey: Math.max(cu.ext[1], r0 * 1.02) });
      });
    }
    // radiation: a diffuse (grey, Lambertian) surface emits over the whole hemisphere with
    // intensity ∝ cos θ, so the direction is sampled cosine-weighted (sin θ = √u). Each ray
    // runs straight until it meets the lid, the floor or a side wall of the enclosure.
    const RAY_V = 40;                      // mm/s, for display only
    function rad(x, y, z, dir, Tc) {
      const u1 = Math.random(), phi = 6.283185 * Math.random();
      const st = Math.sqrt(u1), ct = Math.sqrt(1 - u1);
      const d = [st * Math.cos(phi), st * Math.sin(phi), dir * ct];
      let tHit = Infinity;
      if (g.enc) {
        const lim = (p0, dv, lo, hi) => (dv > 1e-9 ? (hi - p0) / dv : dv < -1e-9 ? (lo - p0) / dv : Infinity);
        tHit = Math.min(lim(x, d[0], -g.W / 2, g.W / 2), lim(y, d[1], -g.H / 2, g.H / 2), lim(z, d[2], g.zFloor, g.zLid));
      } else tHit = 22;
      const life = tHit / RAY_V;
      parts.push({ k: 'r', x, y, z, x0: x, y0: y, z0: z, vx: d[0] * RAY_V, vy: d[1] * RAY_V, vz: d[2] * RAY_V, t: 0, life: life + 0.25, fly: life, T: Tc });
    }
    function step(dt) {
      const out = [];
      for (const p of parts) {
        p.t += dt;
        if (p.t > p.life) continue;
        if (p.k === 'cu') {               // rising plume, spreads under the lid
          const top = g.zLid, gap = top - g.zU;
          const vz = gap / 2.2 * (0.6 + 0.4 * Math.min(1, (p.T - g.lo) / (g.hi - g.lo + 1e-9)));
          const near = g.enc ? Math.max(0, 1 - (top - p.z) / (0.25 * gap)) : 0;
          p.z = Math.min(top - 0.3, p.z + vz * (1 - near) * dt);
          const r = Math.hypot(p.x, p.y) + 1e-6;
          p.x += (Math.sin(p.t * 3 + p.ph) * 1.2 + near * 9 * p.x / r) * dt;
          p.y += (Math.cos(p.t * 2.6 + p.ph) * 1.2 + near * 9 * p.y / r) * dt;
        } else if (p.k === 'cl') {        // stable layer below a hot face: slow, sideways to the edges
          const r = Math.hypot(p.x, p.y) + 1e-6, gap = g.zL - g.zFloor;
          p.z = Math.max(g.zFloor + 0.3, p.z - gap / 5 * dt);
          p.x += (5 * p.x / r + Math.sin(p.t * 2 + p.ph) * 0.6) * dt;
          p.y += (5 * p.y / r + Math.cos(p.t * 2 + p.ph) * 0.6) * dt;
        } else if (p.k === 'r') {
          const tt = Math.min(p.t, p.fly);           // stops at the wall, then flashes
          p.x = p.x0 + p.vx * tt; p.y = p.y0 + p.vy * tt; p.z = p.z0 + p.vz * tt;
        } else if (p.k === 'sp') {
          const v = 10 * (1 - p.t / p.life);
          p.x += p.vx * v * dt; p.y += p.vy * v * dt;
          if (Math.abs(p.x) > p.ex || Math.abs(p.y) > p.ey) continue;
        }
        if (p.k !== 'r' && (Math.abs(p.x) > g.W / 2 || Math.abs(p.y) > g.H / 2)) { if (p.k !== 'cu' && p.k !== 'cl' || g.enc) continue; }
        out.push(p);
      }
      parts = out;
    }
    function drawParts(below) {
      screen();
      for (const p of parts) {
        if ((p.z < 0) !== below) continue;
        const f = p.t / p.life, a = Math.sin(Math.PI * Math.min(1, f * 1.2)) ;
        if (p.k === 'r') {
          // faint ray from the emitting point, a bright head, and a small flash where it lands
          const q0 = P(p.x0, p.y0, p.z0), q = P(p.x, p.y, p.z);
          const back = Math.min(p.t, p.fly, 0.07);
          const q2 = P(p.x - p.vx / RAY_V * back * RAY_V, p.y - p.vy / RAY_V * back * RAY_V, p.z - p.vz / RAY_V * back * RAY_V);
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255,240,190,0.09)';
          ctx.beginPath(); ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
          if (p.t < p.fly) {
            ctx.strokeStyle = 'rgba(255,240,190,0.9)'; ctx.lineWidth = 1.6;
            ctx.beginPath(); ctx.moveTo(q2[0], q2[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
          } else if (g.enc) {
            const k = 1 - (p.t - p.fly) / 0.25;
            ctx.fillStyle = `rgba(255,240,190,${0.55 * k})`;
            ctx.beginPath(); ctx.arc(q[0], q[1], 1.5 + 3 * (1 - k), 0, 6.283); ctx.fill();
          }
        } else {
          const q = P(p.x, p.y, p.z), c = ramp((p.T - g.lo) / (g.hi - g.lo + 1e-9) * 0.85 + 0.15);
          const rr = p.k === 'sp' ? 1.3 : 2.1 + f * 1.4;
          ctx.fillStyle = rgb(p.k === 'sp' ? mix(c, [255, 220, 150], 0.4) : c, (p.k === 'sp' ? 0.55 : 0.7) * a);
          ctx.beginPath(); ctx.arc(q[0], q[1], rr, 0, 6.283); ctx.fill();
        }
      }
    }

    // ------------------------------------------------------------ drawing
    function poly(pts, fill, stroke) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
    }
    // a box's faces that face the camera; normal (nx, ny, nz) in world
    function faceVisible(n) {
      const y1 = n[0] * syw + n[1] * cyw;   // camera sits towards -y1 and +z (for pitch > 0)
      return y1 * cp - n[2] * sp < 0;
    }
    function box(x0, x1, y0, y1, z0, z1, colTop, colSide, colBot) {
      const F = [
        [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], colTop],
        [[0, 0, -1], [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], colBot || colTop],
        [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], colSide[0]],
        [[-1, 0, 0], [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], colSide[0]],
        [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], colSide[1]],
        [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], colSide[1]],
      ];
      screen();
      for (const [n, pts, col] of F) if (col && faceVisible(n)) poly(pts.map(p => P(...p)), col);
    }
    function enclosureFaces(far) {
      if (!g.enc) return;
      const W = g.W / 2, H = g.H / 2;
      screen();
      const fromAbove = pitch > 0;
      // the wall behind the board (floor seen from above, lid from below): a faint filled plane
      if (far) {
        const z = fromAbove ? g.zFloor : g.zLid;
        const Tw = fromAbove ? (g.up ? g.s.TwallF : g.s.TwallC) : (g.up ? g.s.TwallC : g.s.TwallF);
        const c = mix([20, 30, 58], ramp((Tw - g.lo) / (g.hi - g.lo + 1e-9)), 0.25);
        poly([P(-W, -H, z), P(W, -H, z), P(W, H, z), P(-W, H, z)], rgb(c, 0.75), 'rgba(169,192,234,0.25)');
        drawGlow(z, fromAbove ? g.irrFloor : g.irrLid, 0.9);
        drawSideGlow(true);
        // back walls
        for (const [n, pts] of [
          [[1, 0, 0], [[W, -H], [W, H]]], [[-1, 0, 0], [[-W, -H], [-W, H]]], [[0, 1, 0], [[-W, H], [W, H]]], [[0, -1, 0], [[-W, -H], [W, -H]]]]) {
          if (faceVisible(n)) continue;   // inner side of a far wall faces us
          poly([P(pts[0][0], pts[0][1], g.zFloor), P(pts[1][0], pts[1][1], g.zFloor), P(pts[1][0], pts[1][1], g.zLid), P(pts[0][0], pts[0][1], g.zLid)],
            'rgba(17,27,54,0.35)', 'rgba(169,192,234,0.12)');
        }
      } else {
        ctx.strokeStyle = 'rgba(169,192,234,0.35)'; ctx.lineWidth = 1;
        const zs = [g.zFloor, g.zLid];
        for (const z of zs) poly([P(-W, -H, z), P(W, -H, z), P(W, H, z), P(-W, H, z)], null, 'rgba(169,192,234,0.35)');
        for (const [x, y] of [[-W, -H], [W, -H], [W, H], [-W, H]]) {
          const a = P(x, y, g.zFloor), b = P(x, y, g.zLid);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
      }
    }
    function boardFace(top) {
      const z = top ? g.zU : g.zL, img = top ? g.imgU : g.imgL;
      plane(z);
      ctx.transform(g.W / g.s.nx, 0, 0, -g.H / g.s.ny, -g.W / 2, g.H / 2);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, 0, 0);
      plane(z);
      if (mode === 'rad') { ctx.fillStyle = 'rgba(8,14,30,0.6)'; ctx.fillRect(-g.W / 2, -g.H / 2, g.W, g.H); }   // let the glow carry the picture
      const freeSide = top !== g.up;
      if (!freeSide && g.vias.length) {          // component side: the exposed pad and its vias, under the body
        ctx.fillStyle = 'rgba(214,170,110,0.9)';
        ctx.fillRect(-g.arrW / 2, -g.arrH / 2, g.arrW, g.arrH);
        const rH = Math.max(0.02, g.viaD / 2 - g.plating);
        ctx.fillStyle = g.o.via === 'cufill' ? 'rgba(170,110,60,1)' : g.o.via === 'plugged' ? 'rgba(120,120,130,1)' : '#05080f';
        for (const [x, y] of g.vias) { ctx.beginPath(); ctx.arc(x, y, rH, 0, 6.283); ctx.fill(); }
      }
      // edge of the copper connected to the array, when it does not cover the board
      const cu = freeSide ? g.cuF : g.cuC;
      if (cu.mode !== 'plane') {
        ctx.lineWidth = 0.16; ctx.strokeStyle = 'rgba(232,170,100,0.95)';
        ctx.strokeRect(-cu.ext[0], -cu.ext[1], 2 * cu.ext[0], 2 * cu.ext[1]);
      }
      // array outline and vias on the free side
      if (freeSide && g.vias.length) {
        const open = g.o.via === 'open', rP = g.padD / 2, rH = Math.max(0.02, g.viaD / 2 - g.plating);
        const pxPerMm = S;
        for (const [x, y] of g.vias) {
          if (open) {
            ctx.fillStyle = mode === 'rad' ? 'rgba(96,70,44,0.95)' : 'rgba(214,160,92,0.95)'; ctx.beginPath(); ctx.arc(x, y, rP, 0, 6.283); ctx.fill();
            ctx.fillStyle = '#05080f'; ctx.beginPath(); ctx.arc(x, y, rH, 0, 6.283); ctx.fill();
          } else if (pxPerMm * rP > 1.2) {
            ctx.strokeStyle = g.o.via === 'tented' ? 'rgba(160,220,180,0.55)' : 'rgba(230,180,120,0.7)';
            ctx.lineWidth = 0.08; ctx.beginPath(); ctx.arc(x, y, g.viaD / 2, 0, 6.283); ctx.stroke();
          }
        }
        ctx.setLineDash([0.5, 0.4]); ctx.lineWidth = 0.12; ctx.strokeStyle = 'rgba(232,238,251,0.7)';
        ctx.strokeRect(-g.arrW / 2, -g.arrH / 2, g.arrW, g.arrH); ctx.setLineDash([]);
      }
      screen();
      drawGlow(z, top ? g.glowU : g.glowL, 0, boardGlow());
    }
    function boardEdges() {
      const W = g.W / 2, H = g.H / 2;
      box(-W, W, -H, H, g.zL, g.zU, null, ['#2a5a3a', '#214a30'], null);
    }
    function component() {
      const b = g.body / 2, z0 = g.up ? g.zU : g.zL - g.bodyT, z1 = g.up ? g.zU + g.bodyT : g.zL;
      const c = mix([34, 40, 58], ramp((g.s.Tpkg - g.lo) / (g.hi - g.lo + 1e-9)), 0.45);
      // see-through, so the exposed pad and the vias under it stay visible
      box(-b, b, -b, b, z0, z1, rgb(c, 0.42), [rgb(mix(c, [0, 0, 0], 0.25), 0.5), rgb(mix(c, [0, 0, 0], 0.4), 0.5)], rgb(mix(c, [0, 0, 0], 0.2), 0.42));
      screen();
      ctx.strokeStyle = 'rgba(232,238,251,0.55)'; ctx.lineWidth = 1;
      const zt = g.up ? z1 : z0;
      ctx.beginPath();
      [[-b, -b], [b, -b], [b, b], [-b, b]].forEach(([x, y], i) => { const q = P(x, y, zt); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
      ctx.closePath(); ctx.stroke();
      if (mode !== 'conv' && g.pkgAlpha > 0) {
        const vis = g.up ? pitch > 0 : pitch < 0;
        if (vis) {
          plane(zt);
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `rgba(${GLOW[0]},${GLOW[1]},${GLOW[2]},${g.pkgAlpha * shimmer(0) * (mode === 'rad' ? 1 : 0.55)})`;
          ctx.fillRect(-b, -b, 2 * b, 2 * b);
          ctx.globalCompositeOperation = 'source-over';
          screen();
        }
      }
    }
    function ruler() {
      // ticks along the two board edges nearest the camera, labels upright
      const W = g.W, H = g.H, z = pitch > 0 ? g.zU : g.zL;
      const step = niceStep(Math.max(W, H) / 5);
      screen();
      ctx.font = '500 10.5px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(232,238,251,0.85)'; ctx.strokeStyle = 'rgba(232,238,251,0.6)'; ctx.lineWidth = 1;
      const ey = P(0, -H / 2, z)[2] < P(0, H / 2, z)[2] ? -H / 2 : H / 2;      // nearer y edge
      const ex = P(-W / 2, 0, z)[2] < P(W / 2, 0, z)[2] ? -W / 2 : W / 2;      // nearer x edge
      const off = 2.2;
      const tick = (x, y, dx, dy, label, end) => {
        const a = P(x, y, z), b = P(x + dx, y + dy, z), t = P(x + dx * 2.6, y + dy * 2.6, z);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label + (end ? ' mm' : ''), t[0], t[1]);
      };
      const sy = Math.sign(ey), sx = Math.sign(ex);
      for (let v = 0; v <= W + 1e-6; v += step) tick(-W / 2 + v, ey, 0, sy * off, +v.toFixed(1), v + step > W + 1e-6);
      if (W % step > step * 0.25) tick(W / 2, ey, 0, sy * off, +W.toFixed(1), true);
      for (let v = 0; v <= H + 1e-6; v += step) tick(ex, -H / 2 + v, sx * off, 0, +v.toFixed(1), v + step > H + 1e-6);
      if (H % step > step * 0.25) tick(ex, H / 2, sx * off, 0, +H.toFixed(1), true);
    }
    function labels() {
      screen();
      ctx.font = '500 12px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const zt = g.up ? g.zU + g.bodyT : g.zL - g.bodyT;
      const q = P(0, 0, zt);
      const txt = `Tj ${g.s.Tj.toFixed(1)} °C`;
      const w = ctx.measureText(txt).width + 14, ly = q[1] - (pitch > 0 === g.up ? 26 : -40);
      ctx.fillStyle = 'rgba(8,14,30,0.78)'; ctx.strokeStyle = 'rgba(169,192,234,0.4)';
      ctx.beginPath(); ctx.roundRect(q[0] - w / 2, ly - 18, w, 22, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText(txt, q[0], ly);
      ctx.strokeStyle = 'rgba(232,238,251,0.5)'; ctx.beginPath(); ctx.moveTo(q[0], ly + 4); ctx.lineTo(q[0], q[1]); ctx.stroke();
      if (g.enc) {
        ctx.font = '400 11px "JetBrains Mono", ui-monospace, monospace'; ctx.fillStyle = 'rgba(158,171,201,0.95)';
        const lidT = g.up ? g.s.TwallC : g.s.TwallF, flT = g.up ? g.s.TwallF : g.s.TwallC;
        const corner = (z) => { let best = null; for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = P(x * g.W / 2, y * g.H / 2, z); if (!best || p[0] > best[0]) best = p; } return best; };
        const a = corner(g.zLid), b = corner(g.zFloor);
        ctx.textBaseline = 'middle';
        const put = (t, q) => {       // right of the corner, or left of it when it would run off the canvas
          const w = ctx.measureText(t).width;
          if (q[0] + 8 + w > CW - 4) { ctx.textAlign = 'right'; ctx.fillText(t, q[0] - 8, q[1]); }
          else { ctx.textAlign = 'left'; ctx.fillText(t, q[0] + 8, q[1]); }
        };
        put(`lid ${lidT.toFixed(1)} °C`, a);
        put(`floor ${flT.toFixed(1)} °C`, b);
      }
    }
    function draw() {
      if (!g || !CW) return;
      camera();
      screen();
      ctx.clearRect(0, 0, CW, CH);
      const fromAbove = pitch > 0;
      enclosureFaces(true);
      // far side of the board first
      if (fromAbove) { if (!g.up) component(); drawParts(true); }
      else { if (g.up) component(); drawParts(false); }
      boardEdges();
      boardFace(fromAbove);
      if (fromAbove) { if (g.up) component(); drawParts(false); }
      else { if (!g.up) component(); drawParts(true); }
      ruler();
      if (g.enc) { drawGlow(fromAbove ? g.zLid : g.zFloor, fromAbove ? g.irrLid : g.irrFloor, 0.9); drawSideGlow(false); }
      enclosureFaces(false);
      labels();
    }

    // ------------------------------------------------------------ loop
    function frame(t) {
      raf = 0;
      if (!running) return;
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
      clock += dt;
      if (g && !REDUCED) { spawn(dt); step(dt); }
      draw();
      raf = requestAnimationFrame(frame);
    }
    function setRunning() {
      const want = visible && active && !REDUCED;
      if (want && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
      else if (!want && running) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
      if (!running) draw();
    }
    if ('IntersectionObserver' in window) new IntersectionObserver(e => { visible = e[0].isIntersecting; setRunning(); }).observe(canvas);
    new ResizeObserver(resize).observe(canvas);
    document.addEventListener('visibilitychange', () => { visible = !document.hidden; setRunning(); });

    // ------------------------------------------------------------ rotate
    let drag = null;
    const touches = new Map();
    canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing'); });
    canvas.addEventListener('pointermove', e => {
      if (!drag || touches.size > 1) return;
      yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
      pitch = Math.max(-1.35, Math.min(1.45, drag.pitch + (e.clientY - drag.y) * 0.006));
      if (Math.abs(pitch) < 0.04) pitch = pitch < 0 ? -0.04 : 0.04;
      if (!running) draw();
    });
    const end = () => { drag = null; canvas.classList.remove('grabbing'); };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('dblclick', () => { yaw = YAW0; pitch = PITCH0; zoom = 1; if (!running) draw(); });
    // zoom: mouse wheel, or two-finger pinch
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      zoom = Math.max(0.6, Math.min(8, zoom * Math.exp(-e.deltaY * 0.0015)));
      if (!running) draw();
    }, { passive: false });
    let pinch0 = 0, zoom0 = 1;
    canvas.addEventListener('pointerdown', e => {
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); zoom0 = zoom; drag = null; }
    });
    canvas.addEventListener('pointermove', e => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2 && pinch0 > 0) {
        const [a, b] = [...touches.values()];
        zoom = Math.max(0.6, Math.min(8, zoom0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch0));
        if (!running) draw();
      }
    });
    const lift = e => { touches.delete(e.pointerId); if (touches.size < 2) pinch0 = 0; };
    canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);

    resize();
    return {
      update(s, lo, hi) { parts = []; update(s, lo, hi); setRunning(); },
      setActive(a) { active = a; if (a) resize(); setRunning(); },
      view(y, p) { yaw = y; pitch = p; draw(); },
      setMode(m) { mode = m; if (m === 'rad') parts = []; if (!running) draw(); },
      radiation() { return g ? { enc: g.enc, up: g.up, lid: g.irrLid, floor: g.irrFloor, sides: g.irrSides, totals: g.radTotals, qmax: g.qmax } : null; },
      getMode() { return mode; },
    };
  }
  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }
  window.TV3D = { create, ramp };
})();
