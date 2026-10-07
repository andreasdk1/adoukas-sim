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

  fetch(BASE + 'meta.json').then(r => r.json())
    .then(meta => meta.native ? loadNative(meta) : Promise.all([loadImg(BASE + 'fields.png'), loadImg(BASE + 'vel.png'), loadImg(BASE + 'material.png'),
                                                                loadImg(BASE + 'ice.png'), loadImg(BASE + 'vela.png'), loadImg(BASE + 'vap.png').catch(() => null)])
      .then(([fImg, vImg, mImg, iImg, aImg, pImg]) => init(meta, pixels(fImg), pixels(vImg), pixels(mImg), pixels(iImg), iImg.width, pixels(aImg), pImg && pixels(pImg), null)))
    .catch(e => { console.error(e); el('ck-status').textContent = 'Could not load the simulation data.'; });

  // ---------------------------------------------------- data on the solver's own mesh
  // Runs that carry native/ keep every frame as the solver held it: glass and drink cells on the fluid
  // grid, the room air one value per quadtree leaf, the ice on its 0.25 mm cells. Each stretch of the run
  // between restarts (grid switch, level steps) has its own mesh. Frames are decoded on demand onto the
  // finest grid of the run: the air is rebuilt with the solver's own interpolation between the leaves.
  // the frames' values, channel by channel (frame g, entry i at g * L + i), from an atlas of n blocks
  function takeFrames(img, chans, n, L, bw, bh, cols, delta) {
    const px = pixels(img), AW = img.width, out = chans.map(() => new Uint8Array(n * L));
    for (let g = 0; g < n; g++) {
      const r0 = ((g / cols) | 0) * bh, c0 = (g % cols) * bw;
      for (let i = 0; i < L; i++) {
        const o = ((r0 + ((i / bw) | 0)) * AW + c0 + (i % bw)) * 4;
        for (let q = 0; q < chans.length; q++) out[q][g * L + i] = px[o + chans[q]];
      }
    }
    // repacked runs: frames after a chunk's first are the change from the frame before (mod 256)
    if (delta) for (const a of out) for (let k = L; k < n * L; k++) a[k] = (a[k] + a[k - L]) & 255;
    return out;
  }
  // the same for a whole atlas in place (the ice): block g += block g - 1
  function undelta(px, AW, h, w, n, cols) {
    for (let g = 1; g < n; g++) {
      const r0 = ((g / cols) | 0) * h, c0 = (g % cols) * w, r1 = (((g - 1) / cols) | 0) * h, c1 = ((g - 1) % cols) * w;
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const o = ((r0 + r) * AW + c0 + c) * 4, p_ = ((r1 + r) * AW + c1 + c) * 4;
        for (let q = 0; q < 3; q++) px[o + q] = (px[o + q] + px[p_ + q]) & 255;
      }
    }
  }
  const chanSet = imgs => {
    const [T, A, FS] = imgs[0], [U, V] = imgs[1], [AU, AV] = imgs[2], [EV, WV, FILM, PEAK] = imgs[3];
    return { T, A, FS, U, V, AU, AV, EV, WV, FILM, PEAK };
  };
  async function loadNative(meta) {
    const NB = BASE + 'native/', NM = meta.native, STREAMED = !!NM.chunk;
    const TYPED = { uint8: Uint8Array, int32: Int32Array, float32: Float32Array };
    const segs = await Promise.all(NM.segments.filter(sg => sg.n > 0).map(async sg => {
      const [mj, bin, ...imgs] = await Promise.all([
        fetch(NB + `seg${sg.seg}_mesh.json`).then(r => r.json()), fetch(NB + `seg${sg.seg}_mesh.bin`).then(r => r.arrayBuffer()),
        ...(STREAMED ? [] : ['fields', 'vel', 'vela', 'vap'].map(n => loadImg(NB + `seg${sg.seg}_${n}.png`)))]);
      const arr = n => { const a = mj.arrays[n]; return new TYPED[a.dtype](bin, a.offset, a.length); };
      const ns = mj.solid_cells, L = ns + mj.leaves, bw = mj.block_w, bh = mj.block_h;
      const out = { ...sg, nx: mj.nx, ny: mj.ny, dx: mj.dx_mm, ns, L, bw, bh, nq: mj.leaves, mat: arr('material'),
                    airCells: arr('air_cells'), airLeaf: arr('air_leaf'), ip: arr('prolong_indptr'), il: arr('prolong_leaf'), iw: arr('prolong_w') };
      if (!STREAMED) out.ch = chanSet(imgs.map((im, q) => takeFrames(im, [[0, 1, 2], [0, 1], [0, 1], [0, 1, 2, 3]][q], sg.n, L, bw, bh, sg.cols)));
      return out;
    }));
    // streamed runs: the frames come in chunks of NM.chunk, loaded around where the player is
    // (with their stats); a handful are kept
    const stream = STREAMED ? (() => {
      const CHK = NM.chunk, CC = NM.chunk_cols, held = new Map(), MAXHELD = 16;
      // thinned copies for fast playback (make_lod.py): level L holds the frames on whole steps
      const LODS = [null, ...(NM.lod || []).map(l => {
        const all = [], pos = new Map();
        l.segments.forEach(s_ => s_.frames.forEach((f, i) => { all.push(f); pos.set(f, [s_.seg, i, s_.frames]); }));
        return { level: l.level, step: l.step, all, pos };
      })];
      const where = (f, L) => {
        if (L) {
          const e = LODS[L].pos.get(f); if (!e) return null;
          const sg = segs.find(s_ => s_.seg === e[0]), j = Math.floor(e[1] / CHK);
          return { sg, j, g: e[1] - j * CHK, n: Math.min(CHK, e[2].length - j * CHK), key: `${L}:${sg.seg}:${j}`, pre: NB + `seg${sg.seg}_l${L}_c${j}`, fl: e[2], f0: j * CHK };
        }
        const sg = segs.find(s_ => f >= s_.first && f < s_.first + s_.n) || segs[segs.length - 1];
        const j = Math.floor((f - sg.first) / CHK);
        const n = Math.min(CHK, sg.n - j * CHK);
        return { sg, j, g: f - sg.first - j * CHK, n, key: `0:${sg.seg}:${j}`, pre: NB + `seg${sg.seg}_c${j}`, fl: null, f0: sg.first + j * CHK };
      };
      const load = (f, L = 0) => {
        if (f < 0 || f >= meta.frames.length) return null;
        const W_ = where(f, L); if (!W_) return null;
        const { sg, n, key, pre, fl, f0 } = W_;
        if (held.has(key)) { const c = held.get(key); held.delete(key); held.set(key, c); return c.p; }
        const c = { ready: false };
        c.p = Promise.all([...['fields', 'vel', 'vela', 'vap', 'ice'].map(nm => loadImg(`${pre}_${nm}.${NM.ext || 'png'}`)), fetch(pre + '.json').then(r => r.json())])
          .then(([fI, vI, aI, pI, iI, st_]) => {
            c.ch = chanSet([[fI, [0, 1, 2]], [vI, [0, 1]], [aI, [0, 1]], [pI, [0, 1, 2, 3]]].map(([im, chs]) => takeFrames(im, chs, n, sg.L, sg.bw, sg.bh, CC, NM.delta)));
            c.ice = pixels(iI); c.iceW = iI.width / CC;
            if (NM.delta) undelta(c.ice, iI.width, iI.height / Math.ceil(n / CC), c.iceW, n, CC);
            st_.forEach((x, i) => Object.assign(meta.frames[fl ? fl[f0 + i] : f0 + i], x));
            c.ready = true;
          }).catch(e => { held.delete(key); console.error(e); });
        held.set(key, c);
        while (held.size > MAXHELD) held.delete(held.keys().next().value);
        return c.p;
      };
      // a frame's data from whichever loaded chunk has it (the full stream first)
      // (asked per cell by the ice drawing: the last two answers are kept)
      let gA = -1, rA = null, gB = -1, rB = null;
      const get = f => {
        if (f === gA && rA) return rA;
        if (f === gB && rB) return rB;
        for (let L = 0; L < LODS.length; L++) {
          const W_ = where(f, L); if (!W_) continue;
          const c = held.get(W_.key);
          if (c && c.ready) { const r = { c, g: W_.g, sg: W_.sg }; gB = gA; rB = rA; gA = f; rA = r; return r; }
        }
        return null;
      };
      return { load, get, ready: f => !!get(f), CHK, CC, LODS };
    })() : null;
    let iImg = null;
    if (stream) await stream.load(0); else iImg = await loadImg(NB + 'ice.png');
    segs.stream = stream;
    init(meta, null, null, null, iImg && pixels(iImg), iImg && iImg.width, null, true, segs);
  }

  function init(meta, F, V, Mt, ICEPX, ICEWA, VA, VP, NSEG) {
    // native data: the finest grid of the run (the fluid grid while the ice lasts)
    const S0 = NSEG && NSEG.reduce((a, b) => (b.dx < a.dx ? b : a));
    const NX = S0 ? S0.nx : meta.nx, NY = S0 ? S0.ny : meta.ny, NF = meta.frames.length, CELL = S0 ? S0.dx : meta.cell_mm;
    const ETA_CELL = meta.cell_mm;                                           // the surface heights' columns
    const WMM = NX * CELL, HMM = NY * CELL;
    // the table under the glass: the simulated box ends on its surface (the glass stands on it); shown
    // as a slab below the box, so the stage keeps its proportions (older runs: none)
    const TBL = (meta.geometry && meta.geometry.table_mm) || 0;
    const [TLO, THI] = meta.T_range, ABVHI = meta.abv_range[1], VMAX = meta.v_max;
    const TROOM = meta.T_room, TDEW = meta.T_dew, Gm = meta.geometry;
    // frames are tiles of an atlas (CA columns; older data: one tall strip, CA = 1)
    const CA = meta.atlas_cols || 1, CAI = (NSEG ? meta.native.ice_atlas_cols : meta.ice_atlas_cols) || 1, NXA = NX * CA;
    const ICEW = ICEWA / CAI;
    const iat = (fr, nC, r, c) => ((((fr / CAI) | 0) * nC + r) * ICEWA + (fr % CAI) * ICEW + c) * 4;
    // the ice's 0.25 mm cells (0-255) of frame fr, block row r, column c (streamed runs: from the frame's chunk)
    const ICE = NSEG && NSEG.stream ? (fr, nC, r, c) => {
      const S_ = NSEG.stream.get(fr); if (!S_) return 0;
      const CC = NSEG.stream.CC, W_ = S_.c.iceW * CC;
      return S_.c.ice[((((S_.g / CC) | 0) * nC + r) * W_ + (S_.g % CC) * S_.c.iceW + c) * 4];
    } : (fr, nC, r, c) => ICEPX[iat(fr, nC, r, c)];
    const at = (f, k) => ((((f / CA) | 0) * NY + ((k / NX) | 0)) * NXA + (f % CA) * NX + (k % NX)) * 4;

    // material per data cell (row 0 = top): 0 air, 1 glass, 2 liquid (native data: per segment)
    let mat = new Uint8Array(NX * NY);
    if (Mt) for (let k = 0; k < NX * NY; k++) mat[k] = Math.round(Mt[k * 4] / 100);

    // native frames, decoded onto the NX x NY grid (r = 0 at the top): each segment's cells map onto it
    let segOf = null, fd = null, segNow = null;
    if (NSEG) {
      for (const sg of NSEG) {
        const solidIdx = new Int32Array(sg.nx * sg.ny).fill(-1), airIdx = new Int32Array(sg.nx * sg.ny).fill(-1);
        let n = 0;
        for (let k = 0; k < sg.nx * sg.ny; k++) if (sg.mat[k] !== 0) solidIdx[k] = n++;
        sg.airCells.forEach((k, a) => { airIdx[k] = a; });
        // each display cell: bilinear between the segment's four nearest cells of the same material
        // (one cell when the grids coincide), so a coarser segment shows no blocks
        sg.fineMat = new Uint8Array(NX * NY); sg.fsrc = new Int32Array(NX * NY * 4).fill(-1); sg.fw = new Float32Array(NX * NY * 4);
        for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
          const kf = r * NX + c, xm = (c + 0.5) * CELL, ym = (NY - 1 - r + 0.5) * CELL;
          const near = Math.min(sg.ny - 1, (ym / sg.dx) | 0) * sg.nx + Math.min(sg.nx - 1, (xm / sg.dx) | 0), m0 = sg.mat[near];
          sg.fineMat[kf] = m0;
          const u = xm / sg.dx - 0.5, v = ym / sg.dx - 0.5, i0 = Math.floor(u), j0 = Math.floor(v), tx = u - i0, ty = v - j0;
          let n = 0, wsum = 0;
          for (const [di, dj, wt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
            const i = Math.min(sg.nx - 1, Math.max(0, i0 + di)), j = Math.min(sg.ny - 1, Math.max(0, j0 + dj)), ks = j * sg.nx + i;
            if (wt <= 1e-6 || sg.mat[ks] !== m0) continue;
            sg.fsrc[kf * 4 + n] = ks; sg.fw[kf * 4 + n] = wt; n++; wsum += wt;
          }
          if (!n) { sg.fsrc[kf * 4] = near; sg.fw[kf * 4] = 1; } else for (let q = 0; q < n; q++) sg.fw[kf * 4 + q] /= wsum;
        }
        sg.solidIdx = solidIdx; sg.airIdx = airIdx;
        sg.leafN = new Float32Array(sg.nq); for (const l of sg.airLeaf) sg.leafN[l]++;
      }
      segOf = f => NSEG.find(sg => f >= sg.first && f < sg.first + sg.n) || NSEG[NSEG.length - 1];
      // the solver's prolongation: linear between the leaves, then shifted so each leaf keeps its value
      const prolong = (sg, C, base) => {
        const na = sg.airCells.length, y = new Float32Array(na), mean = new Float32Array(sg.nq), x0 = base + sg.ns;
        for (let a = 0; a < na; a++) { let v = 0; for (let j = sg.ip[a]; j < sg.ip[a + 1]; j++) v += sg.iw[j] * C[x0 + sg.il[j]]; y[a] = v; mean[sg.airLeaf[a]] += v; }
        for (let l = 0; l < sg.nq; l++) mean[l] = C[x0 + l] - mean[l] / Math.max(1, sg.leafN[l]);
        for (let a = 0; a < na; a++) y[a] += mean[sg.airLeaf[a]];
        return y;
      };
      const decode = f => {
        const S_ = NSEG.stream && NSEG.stream.get(f), sg = S_ ? S_.sg : segOf(f), nc = sg.nx * sg.ny;
        const base = (S_ ? S_.g : f - sg.first) * sg.L, ch = S_ ? S_.c.ch : sg.ch;
        const air = { T: prolong(sg, ch.T, base), AU: prolong(sg, ch.AU, base), AV: prolong(sg, ch.AV, base),
                      EV: prolong(sg, ch.EV, base), WV: prolong(sg, ch.WV, base) };
        // values on the segment's own cells (8-bit scale), channel by channel; zero velocity is 127.5
        const vals = {};
        for (const name of ['T', 'A', 'FS', 'U', 'V', 'AU', 'AV', 'EV', 'WV', 'FILM', 'RUN', 'PEAK']) {
          const a = new Float32Array(nc), C = name === 'RUN' ? ch.WV : name === 'PEAK' ? (!(meta.film && meta.film.peak) ? ch.FILM : meta.film.peak.startsWith('vap red') ? ch.EV : ch.PEAK) : ch[name], A_ = name === 'RUN' || name === 'PEAK' ? null : air[name];
          const zero = (name === 'U' || name === 'V' || name === 'AU' || name === 'AV' || name === 'WV') ? 127.5 : 0;
          for (let k = 0; k < nc; k++) {
            const si = sg.solidIdx[k];
            if (si >= 0) a[k] = name in air && name !== 'T' ? zero : C[base + si];
            else { const ai = sg.airIdx[k]; a[k] = ai >= 0 && A_ ? A_[ai] : zero; }
          }
          vals[name] = a;
        }
        const N = NX * NY, D = { F: new Uint8ClampedArray(N * 4), V: new Uint8ClampedArray(N * 4), VA: new Uint8ClampedArray(N * 4), VP: new Uint8ClampedArray(N * 4), RN: new Uint8ClampedArray(N), PK: new Uint8ClampedArray(N) };
        const put = (dst, o, a, k) => { let v = 0; for (let q = 0; q < 4; q++) { const ks = sg.fsrc[k * 4 + q]; if (ks < 0) break; v += sg.fw[k * 4 + q] * a[ks]; } dst[o] = v; };
        for (let k = 0; k < N; k++) {
          const o = k * 4;
          put(D.F, o, vals.T, k); put(D.F, o + 1, vals.A, k); put(D.F, o + 2, vals.FS, k);
          put(D.V, o, vals.U, k); put(D.V, o + 1, vals.V, k); put(D.VA, o, vals.AU, k); put(D.VA, o + 1, vals.AV, k);
          put(D.VP, o, vals.EV, k); put(D.VP, o + 1, vals.WV, k); put(D.VP, o + 2, vals.FILM, k);
          { const ks = sg.fsrc[k * 4]; D.RN[k] = ks >= 0 ? vals.RUN[ks] : 0; D.PK[k] = ks >= 0 ? vals.PEAK[ks] : 0; }   // running water, peak: nearest cell
        }
        return D;
      };
      const cache = new Map();
      fd = f => {
        let D = cache.get(f);
        if (!D) { D = decode(f); cache.set(f, D); if (cache.size > 6) cache.delete(cache.keys().next().value); }
        return D;
      };
    }
    if (NSEG) { segNow = segOf(0); mat = segNow.fineMat; Gm.fill_y = segNow.fill_y; }
    // the last two frames asked for, without a map lookup (the draw loops ask per cell)
    let fA = -1, dA = null, fB = -1, dB = null;
    const fr_ = f => (f === fA ? dA : f === fB ? dB : (fB = fA, dB = dA, fA = f, dA = fd(f)));

    // decoded field access, frame f, data cell (c, r) with r=0 at top
    const Tof = NSEG ? (f, k) => TLO + fr_(f).F[k * 4] / 255 * (THI - TLO) : (f, k) => TLO + F[at(f, k)] / 255 * (THI - TLO);
    const ABVof = NSEG ? (f, k) => fr_(f).F[k * 4 + 1] / 255 * ABVHI : (f, k) => F[at(f, k) + 1] / 255 * ABVHI;
    const FSof = NSEG ? (f, k) => fr_(f).F[k * 4 + 2] / 255 : (f, k) => F[at(f, k) + 2] / 255;
    const Uof = NSEG ? (f, k) => (fr_(f).V[k * 4] / 255 * 2 - 1) * VMAX : (f, k) => (V[at(f, k)] / 255 * 2 - 1) * VMAX;
    const Vof = NSEG ? (f, k) => (fr_(f).V[k * 4 + 1] / 255 * 2 - 1) * VMAX : (f, k) => (V[at(f, k) + 1] / 255 * 2 - 1) * VMAX;
    const VMAXA = meta.v_max_air || 0.15;                                    // air velocity, from the simulation
    const AUof = NSEG ? (f, k) => (fr_(f).VA[k * 4] / 255 * 2 - 1) * VMAXA : (f, k) => (VA[at(f, k)] / 255 * 2 - 1) * VMAXA;
    const AVof = NSEG ? (f, k) => (fr_(f).VA[k * 4 + 1] / 255 * 2 - 1) * VMAXA : (f, k) => (VA[at(f, k) + 1] / 255 * 2 - 1) * VMAXA;
    // alcohol vapour in the air (kg per kg), from runs with evaporation; without it the view is hidden
    const EMAX = meta.vap_e_max || 0.04;
    const EVof = NSEG ? (f, k) => fr_(f).VP[k * 4] / 255 * EMAX : (f, k) => VP ? VP[at(f, k)] / 255 * EMAX : 0;
    if (!VP) { el('ck-view-evap').style.display = 'none'; el('ck-evap-row').style.display = 'none'; el('ck-level-row').style.display = 'none'; }
    // water on the glass (µm of film, thickest in each cell), from runs that track the condensate
    const HAS_FILM = !!VP && meta.frames[0].film_ul !== undefined;
    // runs with the drop model carry the water on the glass on a square-root scale (µm) and the water
    // running down it (mm³, log scale); older runs the film in µm directly
    const FM = NSEG && meta.film ? meta.film : null;
    const PEAKof = (f, k) => (fr_(f).PK[k] / 255) ** 2 * FM.max_um;   // most water held so far (µm)
    const FILMof = NSEG ? (FM ? (f, k) => (fr_(f).VP[k * 4 + 2] / 255) ** 2 * FM.max_um : (f, k) => fr_(f).VP[k * 4 + 2]) : (f, k) => VP[at(f, k) + 2];
    const RUNof = (f, k) => { const c = FM ? fr_(f).RN[k] : 0; return c ? 10 ** ((c - 1) / 254 * 5 - 4) : 0; };

    // ------------------------------------------------------------ view state
    const st = { pos: 0, playing: true, speed: 0.25, view: 'temp' };
    let W = 0, H = 0, HC = 0, sc = 1;
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
      W = Math.min(avail, maxH * WMM / (HMM + TBL)); H = W * HMM / WMM; HC = W * (HMM + TBL) / WMM;
      stage.style.width = W + 'px'; stage.style.height = HC + 'px';
      for (const c of [cv, cvP]) {
        c.width = Math.round(W * DPR); c.height = Math.round(HC * DPR);
        c.style.width = W + 'px'; c.style.height = HC + 'px';
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
    // the foot's underside: on the table in newer runs, 15 mm above it in older ones
    const FY = Gm.foot_y ?? 15;
    const STEM_TOP = Gm.apex_out + 1, STEM_BOT = FY + 6, STEM_X = 3.2, FOOT_TOP = FY + 4.5, FOOT_X = 36;
    const R_SLIDE = 1.25, GROW = 4.5e-4, DRY = 2.5e-4;                 // mm, mm/(s·K)
    let drops = [], tPrev = 0, slid = 0;
    // A drop only runs once the simulation runs water off the outside of the glass: each sliding drop
    // (a cap of radius r, ~2/3 pi r³) is paid for out of the water the run has taken off it so far
    const runoff = (f0, f1, w) => ((meta.frames[f0].film_to_table_ul || 0) * (1 - w) + (meta.frames[f1].film_to_table_ul || 0) * w);
    const capV = r => 2 / 3 * Math.PI * r ** 3;
    function startSlide(d, f0, f1, w) {
      if (HAS_FILM && runoff(f0, f1, w) - slid < capV(d.r)) { d.r = Math.min(d.r, R_SLIDE); return; }
      if (HAS_FILM) slid += capV(d.r);
      d.slide = true;
    }
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
        if (d.r > R_SLIDE) startSlide(d, f0, f1, w);
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
          if (keep.r > R_SLIDE && !keep.slide) startSlide(keep, f0, f1, w);
        }
      }
      drops = drops.filter(d => d.r > 0.12);
    }
    function dropsTo(t, f0, f1, w) {                                   // rebuild state after a jump back
      drops = []; slid = 0; let tt = 0;
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
    let liquidCells = [], airCells = [];
    function cellLists() {
      liquidCells = []; airCells = [];
      for (let k = 0; k < NX * NY; k++) { if (mat[k] === 2) liquidCells.push(k); else if (mat[k] === 0) airCells.push(k); }
    }
    cellLists();
    function spawnL(p) { const k = liquidCells[(Math.random() * liquidCells.length) | 0]; p.x = (k % NX) + Math.random(); p.y = ((k / NX) | 0) + Math.random(); p.life = 40 + Math.random() * 80; }
    function spawnA(p) { const k = airCells[(Math.random() * airCells.length) | 0]; p.x = (k % NX) + Math.random(); p.y = ((k / NX) | 0) + Math.random(); p.life = 60 + Math.random() * 160; }
    PL.forEach(spawnL); PA.forEach(spawnA);

    // ABV in the top and bottom 15 mm of the drink, liquid cells only (not ice); native runs carry the
    // same numbers from the simulation (decoding every frame here would hold up the start)
    if (!NSEG) meta.frames.forEach((fr, f) => {
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
    // the two frames around pos and the weight between them; when playing from a thinned copy (LV > 0),
    // its frames around pos
    // (at high speed only every LK-th frame of the copy: unpacking a frame of the fine grid takes ~25 ms)
    let LV = 0, LK = 1;
    function frameAt(pos) {
      pos = Math.max(0, pos);
      const LD = LV && NSEG.stream.LODS[LV];
      if (LD) {
        const a = LD.all, n = Math.floor((a.length - 1) / LK);
        let lo = 0, hi = n;
        if (pos <= a[0]) return [a[0], a[0], 0];
        if (pos >= a[n * LK]) return [a[n * LK], a[n * LK], 0];
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m * LK] <= pos) lo = m; else hi = m; }
        const f0 = a[lo * LK], f1 = a[hi * LK];
        return [f0, f1, (pos - f0) / (f1 - f0)];
      }
      const f0 = Math.min(NF - 1, Math.floor(pos)); return [f0, Math.min(NF - 1, f0 + 1), pos - f0];
    }
    function draw() {
      const [f0, f1, w] = frameAt(st.pos);
      if (NSEG) {                                        // the mesh of the nearer frame's segment
        const sg = segOf(w < 0.5 ? f0 : f1);
        if (sg !== segNow) { segNow = sg; mat = sg.fineMat; Gm.fill_y = sg.fill_y; topRows(); cellLists(); }
      }
      const d = img.data;
      for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
        const k = r * NX + c, o = k * 4, m = mat[k];
        if (m === 0) {
          const ta = Tof(f0, k) * (1 - w) + Tof(f1, k) * w, dev = ta - TROOM;
          if (st.view === 'temp' && dev < -0.2) {
            // air: shown as how much colder than the room it is (a pale blue haze, denser = colder; a
            // darkening blue would draw a dark rim where the coldest air lies on the cold drink)
            const f = Math.min(1, -dev / 12);
            d[o] = 118 + 30 * f; d[o + 1] = 184 + 22 * f; d[o + 2] = 240 + 10 * f; d[o + 3] = Math.min(200, -dev * 22);
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
      cx.clearRect(0, 0, W, HC);
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(off, 0, 0, W, H);
      cx.save(); glassPath(); cx.clip('evenodd'); cx.drawImage(goff, 0, 0, W, H); cx.restore();
      drawIce(f0, f1, w);
      drawSurface(f0, f1, w);
      drawGlass();
      if (TBL) {                                         // the table: a dark slab, its surface a hairline
        cx.fillStyle = '#0f1626'; cx.fillRect(0, H, W, HC - H);
        cx.fillStyle = 'rgba(169,192,234,0.28)'; cx.fillRect(0, H, W, 1);
      }
      if (FM) { drawCondensate(f0, f1, w); drawPool(f0, f1, w); }
      else {
        if (HAS_FILM) { const [g0, g1, gw] = frameAt(st.pos); drawMist(g0, g1, gw); drawPool(g0, g1, gw); }
        drawDrops();
      }
    }
    // ------------------------------------------------------------ the liquid surface
    // Menisci from capillarity (to scale): the surface climbs the glass (contact angle ~30°)
    // and the ice (~0°) and relaxes over the capillary length lc = sqrt(sigma / rho g), which
    // follows the alcohol content of the top layer. Between them, the surface height from the
    // pressure under the (rigid-lid) surface in the simulation, to scale (tens of µm): an
    // exaggerated height drew the surface below the drink the simulation has there.
    const SURF_EXAG = 1;
    const SIG_A = [0, 0.062, 0.123, 0.24, 0.36], SIG_V = [72.0, 56.4, 48.1, 38.0, 33.0];
    function sigmaOf(abv) {
      let i = 0; while (i < SIG_A.length - 2 && abv > SIG_A[i + 1]) i++;
      const f = Math.min(1, Math.max(0, (abv - SIG_A[i]) / (SIG_A[i + 1] - SIG_A[i])));
      return (SIG_V[i] + (SIG_V[i + 1] - SIG_V[i]) * f) * 1e-3;
    }
    const topRow = new Int16Array(NX).fill(-1);
    let ROW_TOP = 0;
    function topRows() {
      topRow.fill(-1);
      for (let c = 0; c < NX; c++) for (let r = 0; r < NY; r++) if (mat[r * NX + c] === 2) { topRow[c] = r; break; }
      ROW_TOP = Math.min(...Array.from(topRow).filter(r => r >= 0));
    }
    topRows();
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
            if (ICE(fr, nC, r, ib * nC + c) < 77) continue;
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
          const a = ICE(fr, nC, r, ib * nC + c) / 255;
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
        const u = Math.min(e0.length - 1.001, Math.max(0, x / ETA_CELL - 0.5)), i = Math.floor(u), t = u - i;
        const a = e0[i] * (1 - t) + e0[i + 1] * t, b = e1[i] * (1 - t) + e1[i + 1] * t;
        return (a * (1 - w) + b * w) * 1e-3 * SURF_EXAG;                                 // mm
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
        // (from a little below the line: there the smoothed field blends the drink with the half-transparent
        // air above it, and the page background would show through as a dark seam)
        const fb = fy - 0.6 * CELL;
        // the meniscus is the drink's own surface layer: its top row of the field image, with the same
        // smoothing, carried up to the curved surface, and only ever inside the bowl
        const grad = (dr) => {
          const gr = cx.createLinearGradient(X(xStart), 0, X(xEnd), 0), span = Math.max(1e-6, xEnd - xStart);
          let any = false;
          for (let c = Math.max(0, Math.floor(xStart / CELL)); c <= Math.min(NX - 1, Math.floor(xEnd / CELL)); c++) {
            if (topRow[c] < 0) continue;
            const o = (Math.max(0, topRow[c] + dr) * NX + c) * 4, t = Math.min(1, Math.max(0, ((c + 0.5) * CELL - xStart) / span));
            gr.addColorStop(t, `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`); any = true;
          }
          if (!any) { const cm = Math.min(NX - 1, Math.max(0, Math.round((x0 + x1) / 2 / CELL))), o = (Math.max(0, topRow[cm] + dr) * NX + cm) * 4; return `rgb(${d[o]},${d[o + 1]},${d[o + 2]})`; }
          return gr;
        };
        cx.save();
        cx.beginPath(); cx.moveTo(X(g.cx - g.half_rim_in), Y(g.rim_y)); cx.lineTo(X(g.cx), Y(g.apex_in));
        cx.lineTo(X(g.cx + g.half_rim_in), Y(g.rim_y)); cx.closePath(); cx.clip();
        // above the surface the smoothed field still blends in the drink's colour (up to half a cell
        // over its level): there it shows the air of the row above instead
        const ft = fy + CELL;
        cx.save();
        cx.beginPath(); cx.moveTo(X(xStart), Y(ft));
        for (let i = 0; i <= N; i++) cx.lineTo(X(xs[i]), Y(Math.min(ft, Math.max(ys[i], fy))));
        cx.lineTo(X(xEnd), Y(ft)); cx.closePath(); cx.clip();
        cx.clearRect(0, 0, W, H);
        cx.drawImage(off, 0, ROW_TOP - 1, NX, 1, 0, Y(ft + CELL), W, Y(fy - CELL) - Y(ft + CELL));
        cx.restore();
        cx.beginPath(); cx.moveTo(X(xStart), Y(fb));
        for (let i = 0; i <= N; i++) cx.lineTo(X(xs[i]), Y(Math.max(ys[i], fy)));
        cx.lineTo(X(xEnd), Y(fb)); cx.closePath(); cx.clip();
        const yTop = Math.max(...ys, fy) + 0.5;
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.drawImage(off, 0, ROW_TOP, NX, 1, 0, Y(yTop), W, Y(fb) - Y(yTop));
        cx.restore();
        cx.fillStyle = grad(-1);
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
    const IB = (NSEG ? meta.native.ice_bodies : meta.ice_bodies) || [];
    const iceCv = IB.map(b => { const c = document.createElement('canvas'); c.width = b.cells; c.height = b.cells; return c; });
    function drawIce(f0, f1, w) {
      const fr = w < 0.5 ? f0 : f1;                     // shape from the nearest frame
      IB.forEach((b, ib) => {
        const { x, y, th } = icePose(ib, f0, f1, w);
        const nC = b.cells, g = iceCv[ib].getContext('2d'), im = g.createImageData(nC, nC);
        const cellA = (2 * b.half / nC) ** 2;
        let area = 0;
        for (let r = 0; r < nC; r++) for (let c = 0; c < nC; c++) area += ICE(fr, nC, r, ib * nC + c) / 255 * cellA;
        // the last slivers (< ~6 mm²) are numerically jittery: fade them out
        const fade = Math.min(1, Math.max(0, (area - 3) / 5));
        if (fade <= 0) return;
        for (let r = 0; r < nC; r++) for (let c = 0; c < nC; c++) {
          const a = ICE(fr, nC, r, ib * nC + c) / 255, o = (r * nC + c) * 4;
          // opaque from half ice: partly melted ice inside a piece (its top, slowly melted by the air) would
          // otherwise let the drink/air edge behind it show through as a line at the drink's level
          im.data[o] = 228; im.data[o + 1] = 240; im.data[o + 2] = 255; im.data[o + 3] = 255 * Math.min(1, Math.max(0, (a - 0.1) / 0.4)) * fade;
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
      cx.moveTo(X(g.cx - xo), Y(g.rim_y)); cx.lineTo(X(g.cx - 3.2), Y(g.apex_out + 3.2 / tanA));
      cx.lineTo(X(g.cx - 3.2), Y(FY + 7)); cx.quadraticCurveTo(X(g.cx - 5.5), Y(FY + 4.5), X(g.cx - 36), Y(FY + 4.5));
      cx.lineTo(X(g.cx - 36), Y(FY)); cx.lineTo(X(g.cx + 36), Y(FY)); cx.lineTo(X(g.cx + 36), Y(FY + 4.5));
      cx.quadraticCurveTo(X(g.cx + 5.5), Y(FY + 4.5), X(g.cx + 3.2), Y(FY + 7)); cx.lineTo(X(g.cx + 3.2), Y(g.apex_out + 3.2 / tanA));
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
      cx.moveTo(X(g.cx - xo), Y(g.rim_y)); cx.lineTo(X(g.cx - 3.2), Y(g.apex_out + 3.2 / tanA));
      cx.lineTo(X(g.cx - 3.2), Y(FY + 7)); cx.quadraticCurveTo(X(g.cx - 5.5), Y(FY + 4.5), X(g.cx - 36), Y(FY + 4.5));
      cx.lineTo(X(g.cx - 36), Y(FY)); cx.lineTo(X(g.cx + 36), Y(FY)); cx.lineTo(X(g.cx + 36), Y(FY + 4.5));
      cx.quadraticCurveTo(X(g.cx + 5.5), Y(FY + 4.5), X(g.cx + 3.2), Y(FY + 7)); cx.lineTo(X(g.cx + 3.2), Y(g.apex_out + 3.2 / tanA));
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
    // The water that ran off the foot: a puddle round its edge on the table (simulated volume, 3D).
    // Spread as a sessile film about 1.4 mm high (water on a table, contact angle ~60°), so its
    // width follows from the volume over the ring round the foot (2 pi FOOT_X long).
    const H_POOL = 1.4;
    function drawPool(f0, f1, w) {
      const v = (meta.frames[f0].pool_ul || 0) * (1 - w) + (meta.frames[f1].pool_ul || 0) * w;   // mm³
      if (v < 0.05) return;
      const hp = Math.min(H_POOL, Math.sqrt(v / (2 * Math.PI * FOOT_X) / 0.7)), wd = v / (2 * Math.PI * FOOT_X * hp * 0.7);
      for (const side of [-1, 1]) {
        const x0 = Gm.cx + side * FOOT_X, x1 = x0 + side * wd;
        cx.beginPath(); cx.moveTo(X(x0), Y(FY));
        cx.lineTo(X(x0), Y(FY + hp));
        cx.bezierCurveTo(X(x0 + side * wd * 0.5), Y(FY + hp), X(x1), Y(FY + hp * 0.6), X(x1), Y(FY));
        cx.closePath();
        cx.fillStyle = 'rgba(200,225,255,0.35)'; cx.fill();
        cx.strokeStyle = 'rgba(255,255,255,0.6)'; cx.lineWidth = 0.8; cx.stroke();
      }
    }
    // ------------------------------------------------------- the water on the glass, as computed
    // The run gives the water on each spot of the glass (h) and the water running down it. Standing
    // drops (dropwise condensation: 0.01-0.7 mm, flat caps at ~30°) are far below a pixel: drawn
    // BEAD_X larger and steeper, their size from h (Rose's largest drop), each in a fixed place; a drop
    // that would touch a larger one has merged into it. Water the run sends down the glass is drawn as
    // its drop (BEAD_X larger) with a wet track; on level tops, water beyond the largest drops a puddle.
    const BEAD_X = 2.5, BEAD_TH = 60 * Math.PI / 180;   // indicative drops: size from the water, steeper caps than the real 30° to be seen
    function wallSamples(seg, side) {                                  // points along a wall: position, tangent, outward normal, into-glass dir
      const out = [];
      if (seg === 0) for (let s = 0; s <= LWALL; s += 1) {             // outer bowl
        const y = Gm.rim_y - 2 - s * COSA, x = Gm.cx + side * (y - Gm.apex_out) * tanA;
        out.push({ s, x, y, T: [side * SINA, COSA], N: [side * COSA, -SINA], sinb: COSA });
      }
      if (seg === 1) for (let s = 0; s <= STEM_TOP - STEM_BOT; s += 1)   // stem
        out.push({ s, x: Gm.cx + side * STEM_X, y: STEM_TOP - s, T: [0, 1], N: [side, 0], sinb: 1 });
      if (seg === 3) for (let y = Gm.fill_y + 1; y <= Gm.rim_y - 1; y += COSA)   // inside the bowl, above the drink
        out.push({ s: y, x: Gm.cx + side * (y - Gm.apex_in) * tanA, y, T: [side * SINA, COSA], N: [-side * COSA, SINA], sinb: COSA });
      if (seg === 2) for (let s = 0; s <= FOOT_X - 6; s += 1)          // top of the foot
        out.push({ s, x: Gm.cx + side * (6 + s), y: FOOT_TOP, T: [side, 0], N: [0, 1], sinb: 0 });
      return out;
    }
    function filmAt(p, f0, f1, w, F_) {                                // the largest value in the glass just behind p
      // the water sits in the glass's surface cells, which step along a sloping wall: search the glass
      // cells within ~1 mm of the point
      let h = 0;
      const c0 = Math.floor((p.x - p.N[0] * 0.3) / CELL), r0 = Math.floor((HMM - (p.y - p.N[1] * 0.3)) / CELL), n = Math.max(1, Math.round(0.8 / CELL));
      for (let r = Math.max(0, r0 - n); r <= Math.min(NY - 1, r0 + n); r++)
        for (let c = Math.max(0, c0 - n); c <= Math.min(NX - 1, c0 + n); c++) {
          const k = r * NX + c;
          if (mat[k] === 1) h = Math.max(h, F_(f0, k) * (1 - w) + F_(f1, k) * w);
        }
      return h;
    }
    function bead(p, d, r) {                                           // a drop of base radius r, d mm along the wall from p
      // a cap whose base lies on the glass: sphere of radius r / sin(th) centred inside the glass
      const sx = p.x + p.T[0] * d, sy = p.y + p.T[1] * d, Rs = r / Math.sin(BEAD_TH), c0 = Rs * Math.cos(BEAD_TH);
      const ox = X(sx - p.N[0] * c0), oy = Y(sy - p.N[1] * c0), base = Math.atan2(-p.N[1], p.N[0]);
      cx.beginPath(); cx.arc(ox, oy, Rs * sc, base - BEAD_TH, base + BEAD_TH); cx.closePath();
      cx.fillStyle = 'rgba(205,228,255,0.35)'; cx.fill();
      cx.strokeStyle = 'rgba(245,250,255,0.9)'; cx.lineWidth = 0.9; cx.stroke();
    }
    function drawCondensate(f0, f1, w) {
      const CV = FM.c_v, [ , TA_, TR_] = FM.theta_deg.map(d => d * Math.PI / 180);
      const rRun = sinb => Math.sqrt(2 * FM.sigma * (Math.cos(TR_) - Math.cos(TA_)) / (1000 * 9.81 * sinb * CV)) * 1000;
      for (const side of [-1, 1]) for (const seg of [0, 1, 3, 2]) {
        const pts = wallSamples(seg, side), rdep = seg === 2 ? FM.l_cap_mm : rRun(pts.length ? pts[0].sinb : 1);
        let prev = null; const beads = [], runners = [];
        pts.forEach((p, i) => {
          const h = filmAt(p, f0, f1, w, FILMof);                     // µm
          // which drops there are and which have merged follows the most water this spot has held; as it
          // evaporates they shrink in place (volume with the water now)
          const hp = Math.max(h, filmAt(p, f0, f1, w, PEAKof));
          if (h > 0.3) {                                              // drops here: up to 3 candidates per mm
            const rmax = Math.min(4 * Math.PI * hp / 1000 / CV, rdep), rb = Math.min(1.4, 0.35 + rmax * BEAD_X);
            for (let j = 0; j < 3; j++) {
              const q = 0.25 + 0.75 * hash(i * 31 + j * 7 + 3, side * 11 + seg * 3) ** 2;
              beads.push([i + hash(i * 13 + j, seg + side * 2) - 0.5, rb * q, p, Math.cbrt(h / hp)]);
            }
          }
          prev = p;
          if (seg === 2 && h / 1000 > CV * rdep / (4 * Math.PI)) {      // level top beyond its largest drops: a puddle
            const d = Math.min(0.95, h / 1000);
            cx.fillStyle = 'rgba(196,222,255,0.30)'; cx.fillRect(X(Math.min(p.x, p.x + side)), Y(p.y + d), sc, d * sc);
          }
          // water running down here (the simulation's): its drop, with a wet streak behind it
          // (the run moves a drop one cell per step: between frames it jumps, so it is shown where the
          // nearer frame has it, not blended)
          const fn = w < 0.5 ? f0 : f1, run = filmAt(p, fn, fn, 0, RUNof);
          if (run > 1e-4) runners.push([p, Math.min(1.8, Math.cbrt(run / CV) * BEAD_X)]);
        });
        {
          // coalescence: drops that touch become one, with their volume (r³ adds), at their centre of
          // volume; repeated until none touch. Worked out from the current water, so it is the same
          // whichever way the player moves through the run
          let dr = beads.map(([u, r, p, sh]) => [u, r, p, sh]).sort((a, b) => a[0] - b[0]), merged = true;
          while (merged) {
            merged = false; const out = [];
            for (const d of dr) {
              const q = out[out.length - 1];
              if (q && d[0] - q[0] < 1.05 * (d[1] + q[1])) {
                const v1 = q[1] ** 3, v2 = d[1] ** 3;
                q[0] = (q[0] * v1 + d[0] * v2) / (v1 + v2); q[1] = Math.min(rdep * BEAD_X, Math.cbrt(v1 + v2));
                if (v2 > v1) q[2] = d[2];
                merged = true;
              } else out.push(d);
            }
            dr = out;
          }
          const placed = dr.map(([u, r, , sh]) => [u, r * sh, pts[Math.max(0, Math.min(pts.length - 1, Math.round(u)))]]);
          for (const [u, r, p] of placed) bead(p, u - Math.round(u), r);
          // sliding drops: the largest drop of the cells it covers, a faint wet track up the glass behind it
          for (const [p, r] of runners) {
            cx.strokeStyle = 'rgba(205,228,255,0.18)'; cx.lineWidth = Math.max(1, 0.8 * r * sc); cx.lineCap = 'round';
            cx.beginPath(); cx.moveTo(X(p.x), Y(p.y)); cx.lineTo(X(p.x + p.T[0] * 5), Y(p.y + p.T[1] * 5)); cx.stroke();
            bead(p, 0, r);
          }
        }
      }
    }
    function drawMist(f0, f1, w) {
      if (!HAS_FILM) return;
      for (const side of [-1, 1]) for (const seg of [0, 1]) {
        const L = seg === 0 ? LWALL : STEM_TOP - STEM_BOT;
        let prev = null;
        for (let s = 0, n = 0; s <= L; s += 0.45, n++) {
          const h = wallFilm({ side, seg, s, r: 0 }, f0, f1, w);
          const [xm, ym] = onWall({ side, seg, s, r: 0 });
          // fog: the glass turns milky as the water condenses (faint at a few µm, a clear haze by ~40 µm)
          if (prev && h > 0.3) {
            cx.strokeStyle = `rgba(226,238,255,${0.04 + 0.16 * Math.min(1, h / 40)})`; cx.lineWidth = Math.max(1, 0.55 * sc);
            cx.beginPath(); cx.moveTo(X(prev[0] + side * 0.2), Y(prev[1])); cx.lineTo(X(xm + side * 0.2), Y(ym)); cx.stroke();
          }
          prev = [xm, ym];
          if (h < 1) continue;
          const nd = Math.min(3, Math.ceil(h / 10));
          cx.fillStyle = 'rgba(232,242,255,0.35)';
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
      const cs = CELL * sc, PSTEP = 1.5 / CELL;           // streaks step in mm (as on the 1.5 mm grid)
      // liquid (time-lapse direction of the stored flow)
      px.strokeStyle = st.view === 'flow' ? 'rgba(170,215,255,0.9)' : 'rgba(255,255,255,0.45)';
      px.lineWidth = st.view === 'flow' ? 1.2 : 0.9;
      px.beginPath();
      for (const p of PL) {
        const k = Math.min(NY - 1, p.y | 0) * NX + Math.min(NX - 1, p.x | 0);
        if (mat[k] !== 2 || FSof(f0, k) > 0.5 || --p.life < 0) { spawnL(p); continue; }
        const uu = Uof(f0, k) * (1 - w) + Uof(f1, k) * w, vv = Vof(f0, k) * (1 - w) + Vof(f1, k) * w;
        const x2 = p.x + uu / VMAX * 0.9 * PSTEP, y2 = p.y - vv / VMAX * 0.9 * PSTEP;
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
        const x2 = p.x + uu / VMAXA * 1.4 * PSTEP, y2 = p.y - vv / VMAXA * 1.4 * PSTEP;
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
      // water on the glass: how much, and whether the glass is still below the dew point (forming) or not (drying)
      const wet = lerpStat('wet'), film = meta.frames[0].film_ul !== undefined ? lerpStat('film_ul') : null;
      if (film === null) el('ck-dew').textContent = wet > 0.02 ? `wet · ${Math.round(wet * 100)} %` : 'dry';
      else if (film < 1 && wet <= 0.02) el('ck-dew').textContent = 'dry';
      else el('ck-dew').textContent = `${film < 100 ? Math.round(film) + ' µL' : (film / 1000).toFixed(2) + ' mL'} · ${wet > 0.02 ? 'forming' : 'drying'}`;
      if (VP && meta.frames[0].evap_pct !== undefined) {
        const v = lerpStat('evap_pct'), a = lerpStat('ethanol_lost_pct'), lv = lerpStat('level_drop_mm');
        const pc = x => x.toFixed(x < 1 ? 2 : 1) + ' %';
        el('ck-evap').textContent = `${pc(v)} / ${pc(a)}`;
        el('ck-level').textContent = `−${lv.toFixed(lv < 0.1 ? 3 : 2)} mm`;
      }
      el('ck-scrub').value = posToU(st.pos);
    }
    // the time axis of the scrub bar and the chart: frame by frame, but when the frames are dense while the
    // ice melts (most of them), that stretch gets a set share of the width and the rest of the run the remainder
    const FD = (() => {
      const fr = meta.frames; let k = 1;
      while (k < NF && fr[k].t - fr[k - 1].t < 1) k++;
      return k - 1 > 0.6 * NF ? k - 1 : 0;                              // last frame of the dense stretch
    })(), UD = 0.55;
    // (after it, linear in time: the frames there are 10 s, then 1 and 5 min apart)
    const TD = meta.frames[FD].t, TE = meta.frames[NF - 1].t;
    function posToU(f) {
      if (!FD) return f / (NF - 1);
      if (f <= FD) return UD * f / FD;
      const i = Math.min(NF - 2, Math.floor(f)), t = meta.frames[i].t + (f - i) * (meta.frames[i + 1].t - meta.frames[i].t);
      return UD + (1 - UD) * (t - TD) / (TE - TD);
    }
    function uToPos(u) {
      u = Math.max(0, Math.min(1, u));
      if (!FD) return u * (NF - 1);
      return u <= UD ? u / UD * FD : Math.max(FD, timeToPos(TD + (u - UD) / (1 - UD) * (TE - TD)) ?? NF - 1);
    }
    window.__ckPosToU = posToU;
    // the bottom 15 mm is a small volume whose alcohol content jumps as meltwater arrives: the chart's
    // top/bottom ratio is averaged over 30 s
    const RATIO = meta.frames[0].abv_tb === undefined ? null : (() => {
      const fr = meta.frames, out = new Array(NF).fill(null); let a = 0, b = 0, sum = 0, n = 0;
      for (let f = 0; f < NF; f++) {
        while (b < NF && fr[b].t <= fr[f].t + 15) { if (fr[b].abv_tb != null) { sum += fr[b].abv_tb; n++; } b++; }
        while (fr[a].t < fr[f].t - 15) { if (fr[a].abv_tb != null) { sum -= fr[a].abv_tb; n--; } a++; }
        out[f] = n ? sum / n : null;
      }
      return out;
    })();                                          // for the screenshot scripts
    // small chart: drink temperature, ice remaining and the alcohol layering vs time
    function drawChart() {
      // x: the scrub bar's axis; marks at round times
      const w = chart.width / DPR, h = chart.height / DPR, pad = 6;
      chx.clearRect(0, 0, w, h);
      const xf = f => pad + posToU(f) * (w - 2 * pad);
      const yT = T => h - pad - ((T - TMIN) / (TMAX - TMIN)) * (h - 2 * pad);
      const yI = f => h - pad - f * (h - 2 * pad);
      chx.strokeStyle = 'rgba(169,192,234,0.15)'; chx.lineWidth = 1;
      chx.beginPath(); chx.moveTo(pad, yT(TDEW)); chx.lineTo(w - pad, yT(TDEW)); chx.stroke();
      chx.font = '9px ui-monospace, monospace'; chx.fillStyle = 'rgba(169,192,234,0.55)'; chx.textAlign = 'center';
      let lastX = -1e9;
      for (const tm of [60, 120, 300, 600, 900, 1800, 2700, 3600, 5400, 7200, 10800]) {
        const fm = timeToPos(tm); if (fm == null) continue;
        const x = xf(fm); if (x - lastX < 32) continue; lastX = x;
        chx.strokeStyle = 'rgba(169,192,234,0.12)'; chx.beginPath(); chx.moveTo(x, pad); chx.lineTo(x, h - pad - 9); chx.stroke();
        chx.fillText(tm < 3600 ? `${tm / 60}′` : `${tm / 3600}h`, x, h - 2);
      }
      chx.textAlign = 'start';
      chx.lineWidth = 1.6;
      chx.strokeStyle = '#e9c46a'; chx.beginPath();
      meta.frames.forEach((fr, f) => (f ? chx.lineTo(xf(f), yT(fr.T_drink)) : chx.moveTo(xf(f), yT(fr.T_drink)))); chx.stroke();
      chx.strokeStyle = '#a9d8ff'; chx.beginPath();
      meta.frames.forEach((fr, f) => (f ? chx.lineTo(xf(f), yI(fr.ice)) : chx.moveTo(xf(f), yI(fr.ice)))); chx.stroke();
      if (RATIO) {                                                       // ABV top / bottom, 1 (mixed) to 4
        const yR = q => h - pad - Math.max(0, Math.min(1, (q - 1) / 3)) * (h - 2 * pad);
        chx.strokeStyle = '#c9a7ff'; chx.lineWidth = 1.3; chx.beginPath(); let on = false;
        RATIO.forEach((q, f) => { if (q == null) { on = false; return; }
          on ? chx.lineTo(xf(f), yR(q)) : chx.moveTo(xf(f), yR(q)); on = true; });
        chx.stroke();
      }
      const xc = xf(st.pos);
      chx.strokeStyle = 'rgba(255,255,255,0.8)'; chx.lineWidth = 1;
      chx.beginPath(); chx.moveTo(xc, pad); chx.lineTo(xc, h - pad); chx.stroke();
    }
    function timeToPos(t) {                                            // fractional frame at time t (s)
      if (t > meta.frames[NF - 1].t) return null;
      let lo = 0, hi = NF - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (meta.frames[m].t <= t) lo = m; else hi = m; }
      const t0 = meta.frames[lo].t, t1 = meta.frames[hi].t;
      return lo + (t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0);
    }

    // ---------------------------------------------------------------- loop
    let last = performance.now(), running = false, raf = 0, onScreen = true;
    function frame(now) {
      const dtw = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now;   // rAF time can precede start()
      const SM = NSEG && NSEG.stream;
      const have = p_ => { const [a, b] = frameAt(p_); return SM.ready(a) && SM.ready(b); };
      if (st.playing) {
        // playback pace in simulated seconds per second at 1×, whatever the frame spacing
        const f0_ = Math.min(NF - 2, Math.floor(st.pos)), tf = meta.frames[f0_].t, gap = Math.max(1e-6, meta.frames[f0_ + 1].t - tf);
        const pace = tf < 1200 ? 24 : tf < 3600 ? 48 : tf < 5400 ? 96 : 480;   // slower while the ice lasts
        if (SM) {
          // more frames a second than can be shown: play from the thinnest copy that keeps it to ~40
          LV = 0;
          for (let L = 1; L < SM.LODS.length; L++)
            if (st.speed * pace / Math.max(gap, LV ? SM.LODS[LV].step : gap) > 40 && SM.LODS[L].step > gap) LV = L;
          LK = LV ? Math.max(1, Math.ceil(st.speed * pace / (SM.LODS[LV].step * 15))) : 1;
        }
        const next = Math.min(NF - 1, st.pos + dtw * st.speed * pace / gap);
        if (!SM || have(next)) st.pos = next;                            // streamed: wait for the data
        if (st.pos >= NF - 1) { st.pos = NF - 1; st.playing = false; playIcon('replay'); }
      } else if (SM) LV = 0;                                             // paused: every frame
      const [f0, f1, w] = frameAt(st.pos);
      if (SM) {
        // the chunks here and the next two ahead (of the copy playing); until this frame's data is in,
        // keep the last picture
        SM.load(f0, LV); SM.load(f1, LV);
        if (LV) { const a = SM.LODS[LV].all, i = a.indexOf(f1); SM.load(a[Math.min(a.length - 1, i + SM.CHK)], LV); SM.load(a[Math.min(a.length - 1, i + 2 * SM.CHK)], LV); SM.load(a[Math.min(a.length - 1, i + 3 * SM.CHK)], LV); }
        else { SM.load(f1 + SM.CHK); SM.load(f1 + 2 * SM.CHK); }
        const ok = have(st.pos); el('ck-buffer').hidden = ok;
        if (!ok) { drawChart(); if (running) raf = requestAnimationFrame(frame); return; }
      }

      if (!FM) updateDrops(f0, f1, w, dtw);
      draw(); drawParticles(f0, f1, w);
      readouts(); drawChart();
      if (running) raf = requestAnimationFrame(frame);
    }
    function start() { if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } }
    function stop() { running = false; cancelAnimationFrame(raf); }

    // ------------------------------------------------------------ controls
    const scrub = el('ck-scrub'); scrub.max = 1; scrub.step = 0.00001;
    scrub.addEventListener('input', () => { st.pos = uToPos(+scrub.value); if (st.pos < NF - 1) playIcon(st.playing ? 'pause' : 'play'); });
    // click or drag on the chart: go to that point (same axis as the scrub bar)
    function chartSeek(e) {
      const r = chart.getBoundingClientRect(), pad = 6;
      st.pos = uToPos((e.clientX - r.left - pad) / (r.width - 2 * pad));
      if (st.pos < NF - 1) playIcon(st.playing ? 'pause' : 'play');
    }
    chart.addEventListener('pointerdown', e => { chart.setPointerCapture(e.pointerId); chartSeek(e); });
    chart.addEventListener('pointermove', e => { if (chart.hasPointerCapture(e.pointerId)) chartSeek(e); });
    // the play button as an icon (play / pause / replay), so the speeds fit beside it
    function playIcon(k) {
      const b = el('ck-play'), d = { play: 'M8 5.5v13l11-6.5z', pause: 'M7 5h3.6v14H7zM13.4 5H17v14h-3.6z',
        replay: 'M12 5a7 7 0 1 1-6.6 4.7l1.9.6A5 5 0 1 0 12 7v3L7.5 6 12 2z' }[k];
      b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
      b.setAttribute('aria-label', k[0].toUpperCase() + k.slice(1)); b.title = b.getAttribute('aria-label');
    }
    playIcon(st.playing ? 'pause' : 'play');
    el('ck-play').addEventListener('click', () => {
      if (st.pos >= NF - 1) st.pos = 0;
      st.playing = !st.playing; playIcon(st.playing ? 'pause' : 'play');
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
