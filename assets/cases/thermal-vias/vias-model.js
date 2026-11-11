// Thermal via array under a component, in a small passively cooled enclosure.
//
// Board: two conducting sheets (the component side and the free side), each
// copper pour + half the FR4 in plane, with the inner planes lumped into the
// nearer sheet. The sheets are coupled through the thickness by FR4 everywhere
// and, inside the array, by the via barrels and their fill (smeared over the
// array cells). The component covers its footprint on its own side: its power
// enters the pad through R_jb, and part leaves through its own top (R_jt) to
// the air and the enclosure wall on that side.
//
// Each exposed face loses heat to the enclosure wall it faces, by natural
// convection across the air layer (heated from below: Hollands' Bénard
// correlation; heated from above: stable layer, the larger of conduction and
// the free lower-face correlation) and by grey-body radiation between parallel
// plates. The two walls lose heat to the room through an outside coefficient.
// With a fan, the air is exchanged with the room and convection follows a
// laminar flat-plate correlation, combined with natural convection.
//
// On the free side the via array is either tented (solder mask over it) or
// open (a mask opening the size of each via pad: bare finish on the ring and
// an open hole). The open hole is a dead end, closed by the solder under the
// component, so it is credited with convection over its opening and cavity
// radiation; the air inside cannot flow through.
//
// The steady problem is linear for fixed h; it is solved with Jacobi-
// preconditioned conjugate gradients inside a Picard loop on h(T).
(function (root) {
  'use strict';

  const SIGMA = 5.670374e-8, G = 9.81;
  const K_CU = 385, K_FR4_Z = 0.3, K_FR4_XY = 0.8, K_MASK = 0.25, T_MASK = 20e-6;
  const K_AIR = 0.0263, NU_AIR = 1.6e-5, ALPHA_AIR = 2.25e-5, PR_AIR = 0.71;
  const EPS_MASK = 0.9, EPS_WALL = 0.9, EPS_PKG = 0.9, EPS_HOLE = 0.8;
  const OZ = 34.8e-6;

  // Via fill: conductivity of what is inside the plated barrel.
  const FILL = {
    open: { k: K_AIR, label: 'Open (untented)' },
    tented: { k: K_AIR, label: 'Tented on the free side' },
    plugged: { k: 0.3, label: 'Epoxy plugged and capped' },
    cufill: { k: K_CU, label: 'Copper filled' },
  };

  const DEFAULTS = {
    // array area (the component's exposed pad) and fab rules
    arrW: 4.0e-3, arrH: 4.0e-3,
    dMin: 0.3e-3, ring: 0.15e-3, hole2hole: 0.25e-3, padGap: 0,
    plating: 25e-6, arMax: 10,
    // board
    boardW: 50e-3, boardH: 40e-3, tb: 1.6e-3,
    layers: 2, outerOz: 1, innerOz: 0.5, coverage: 0.7,
    finishEps: 0.1,
    // component
    P: 2.0, bodyW: 6e-3, bodyH: 6e-3, bodyT: 0.9e-3, Rjb: 2.5, Rjt: 20,
    side: 'top',            // component on the upper ('top') or lower ('bottom') face
    via: 'tented',
    // enclosure and cooling
    enclosure: true, gapUp: 30e-3, gapDn: 10e-3, hExt: 10,
    Tamb: 25, fan: 0,
    grid: 0.5e-3,
  };

  // --------------------------------------------------------------- air layer
  function ra(dT, L) { return G * Math.abs(dT) / (273.15 + 25 + dT / 2) * L * L * L / (NU_AIR * ALPHA_AIR); }
  // hot face pointing up (into the layer above it)
  function hUp(dT, H, L, confined) {
    if (dT <= 0) return K_AIR / (confined ? H : L);
    const rL = ra(dT, L);
    const hOpen = (rL < 1e7 ? 0.54 * Math.pow(rL, 0.25) : 0.15 * Math.cbrt(rL)) * K_AIR / L;
    if (!confined) return Math.max(hOpen, 0.5 * K_AIR / L);
    const r = ra(dT, H);
    const nu = 1 + 1.44 * Math.max(0, 1 - 1708 / r) + Math.max(0, Math.cbrt(r / 5830) - 1);
    return Math.max(nu * K_AIR / H, hOpen);
  }
  // hot face pointing down (stable layer below it)
  function hDn(dT, H, L, confined) {
    const rL = ra(Math.max(dT, 0), L);
    const hOpen = 0.27 * Math.pow(rL, 0.25) * K_AIR / L;
    return confined ? Math.max(K_AIR / H, hOpen) : Math.max(hOpen, 0.25 * K_AIR / L);
  }
  function hForced(v, L) {
    if (!(v > 0)) return 0;
    const re = v * L / NU_AIR;
    return 0.664 * Math.sqrt(re) * Math.cbrt(PR_AIR) * K_AIR / L;
  }
  const combine = (hn, hf) => Math.cbrt(hn * hn * hn + hf * hf * hf);
  function hRad(eps1, eps2, T1, T2) {   // kelvin
    const e = 1 / (1 / eps1 + 1 / eps2 - 1);
    return e * SIGMA * (T1 * T1 + T2 * T2) * (T1 + T2);
  }

  // ------------------------------------------------------------- the array
  function viaConductance(d, o) {
    const r = d / 2, ri = Math.max(r - o.plating, 0);
    const barrel = K_CU * Math.PI * (r * r - ri * ri) / o.tb;
    const fill = FILL[o.via].k * Math.PI * ri * ri / o.tb;
    return { barrel, fill, total: barrel + fill };
  }
  // Fit the most vias of drill d into the array rectangle.
  function layout(d, o) {
    const pad = d + 2 * o.ring;
    const pitch = Math.max(d + o.hole2hole, pad + o.padGap);
    const fit = L => (L + 1e-12 < pad ? 0 : Math.floor((L - pad) / pitch + 1e-9) + 1);
    const m = fit(o.arrW), n = fit(o.arrH);
    return { d, pad, pitch, m, n, N: m * n };
  }
  // Through-thickness conductance of the array area (vias + FR4 between them).
  function arrayConductance(d, o) {
    const L = layout(d, o);
    const g = viaConductance(d, o);
    const A = o.arrW * o.arrH;
    const Afr4 = Math.max(A - L.N * Math.PI * d * d / 4, 0);
    const Gfr4 = K_FR4_Z * Afr4 / o.tb;
    const G = L.N * g.total + Gfr4;
    return { ...L, Gvia: g.total, Gbarrel: L.N * g.barrel, Gfill: L.N * g.fill, Gfr4, G, R: 1 / G };
  }
  // Drill sizes from dMin up, in 0.05 mm steps to 1 mm, within the aspect ratio.
  function drillCandidates(o) {
    const out = [], dAr = o.tb / o.arMax;
    const d0 = Math.max(o.dMin, dAr);
    out.push(d0);
    for (let d = Math.ceil(d0 / 0.05e-3 - 1e-6) * 0.05e-3; d <= 1.0e-3 + 1e-9; d += 0.05e-3) {
      if (d > d0 + 1e-9) out.push(+d.toFixed(6));
    }
    return out;
  }
  function optimise(o) {
    const rows = drillCandidates(o).map(d => arrayConductance(d, o)).filter(r => r.N > 0);
    let best = null;
    for (const r of rows) if (!best || r.G > best.G * (1 + 1e-9)) best = r;
    return { rows, best };
  }

  // ------------------------------------------------------------ board model
  // Rectangle overlap fraction of cell (i, j) with rect centred on the board.
  function coverFrac(x0, x1, y0, y1, w, h, cx, cy) {
    const ox = Math.max(0, Math.min(x1, cx + w / 2) - Math.max(x0, cx - w / 2));
    const oy = Math.max(0, Math.min(y1, cy + h / 2) - Math.max(y0, cy - h / 2));
    return (ox * oy) / ((x1 - x0) * (y1 - y0));
  }

  function solve(opts, arr) {
    const o = { ...DEFAULTS, ...opts };
    if (!arr) arr = optimise(o).best;
    const nx = Math.max(10, Math.round(o.boardW / o.grid)), ny = Math.max(10, Math.round(o.boardH / o.grid));
    const dx = o.boardW / nx, dy = o.boardH / ny, Ac = dx * dy, nc = nx * ny;
    const cx = o.boardW / 2, cy = o.boardH / 2;

    // sheet conductances (W/K per square): component side c, free side f
    const tOut = o.outerOz * OZ, tIn = o.innerOz * OZ, nIn = Math.max(0, o.layers - 2);
    const kt = K_CU * o.coverage * (tOut + tIn * nIn / 2) + K_FR4_XY * o.tb / 2;
    const gx = kt * dy / dx, gy = kt * dx / dy;

    // per-cell geometry fractions
    const fArr = new Float64Array(nc), fBody = new Float64Array(nc);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x0 = i * dx, y0 = j * dy, c = j * nx + i;
      fArr[c] = coverFrac(x0, x0 + dx, y0, y0 + dy, o.arrW, o.arrH, cx, cy);
      fBody[c] = coverFrac(x0, x0 + dx, y0, y0 + dy, Math.max(o.bodyW, o.arrW), Math.max(o.bodyH, o.arrH), cx, cy);
    }
    const Aarr = o.arrW * o.arrH;
    const gzFr4 = K_FR4_Z * Ac / o.tb;                       // per cell, no vias
    const gzArr = arr ? arr.G / Aarr * Ac : gzFr4;           // per cell, full array
    // free-side surface of the array area
    const r = arr ? arr.d / 2 : 0, ri = arr ? Math.max(r - o.plating, 0) : 0;
    const N = arr ? arr.N : 0;
    const open = o.via === 'open';
    const padOpen = open ? Math.min(1, N * Math.PI * (arr.pad / 2 + 0.05e-3) ** 2 / Aarr) : 0;
    const holeFrac = open ? N * Math.PI * ri * ri / Aarr : 0;
    const ringFrac = padOpen - holeFrac;
    const maskFrac = 1 - padOpen;
    const epsArrFree = maskFrac * EPS_MASK + ringFrac * o.finishEps + holeFrac * EPS_HOLE;

    // orientation: which wall each side faces
    const compUp = o.side === 'top';
    const Lc = o.boardW * o.boardH / (2 * (o.boardW + o.boardH));
    const gapC = compUp ? o.gapUp : o.gapDn, gapF = compUp ? o.gapDn : o.gapUp;
    const conf = !!o.enclosure && !o.fixedH;
    const hfan = hForced(o.fan, o.boardW);
    const Tamb = o.Tamb + 273.15;
    const Abody = Math.max(o.bodyW, o.arrW) * Math.max(o.bodyH, o.arrH);
    const Awall = o.boardW * o.boardH, per = 2 * (o.boardW + o.boardH);
    const AwC = Awall + per * gapC, AwF = Awall + per * gapF;

    // unknowns: [0..nc) component sheet, [nc..2nc) free sheet, J, K(pkg top), WC, WF
    const n = 2 * nc + 4, iJ = 2 * nc, iK = iJ + 1, iWC = iJ + 2, iWF = iJ + 3;
    const T = new Float64Array(n).fill(Tamb);
    const hcC = new Float64Array(nc), hrC = new Float64Array(nc), hcF = new Float64Array(nc), hrF = new Float64Array(nc);
    const epsF = new Float64Array(nc);
    for (let c = 0; c < nc; c++) epsF[c] = fArr[c] * epsArrFree + (1 - fArr[c]) * EPS_MASK;
    const maskR = T_MASK / K_MASK;
    let hpC = 0, hpR = 0;

    function faceH(dT, upward, gap) {
      const hn = upward ? hUp(dT, gap, Lc, conf) : hDn(dT, gap, Lc, conf);
      return hfan > 0 ? combine(hn, hfan) : hn;
    }
    function updateH() {
      if (o.fixedH) {                                  // test mode: fixed h, no radiation, walls at ambient
        for (let c = 0; c < nc; c++) { hcC[c] = (1 - fBody[c]) * o.fixedH.c; hrC[c] = 0; hcF[c] = o.fixedH.f; hrF[c] = 0; }
        hpC = o.fixedH.c * Abody; hpR = 0;
        return;
      }
      const TwC = conf ? T[iWC] : Tamb, TwF = conf ? T[iWF] : Tamb;
      const TaC = hfan > 0 || !conf ? Tamb : TwC, TaF = hfan > 0 || !conf ? Tamb : TwF;
      for (let c = 0; c < nc; c++) {
        const tc = T[c], tf = T[nc + c];
        // component side: covered under the body
        const exposedC = 1 - fBody[c];
        const hC = faceH(tc - TaC, compUp, gapC), hF = faceH(tf - TaF, !compUp, gapF);
        hcC[c] = exposedC * 1 / (1 / hC + maskR);
        hrC[c] = exposedC * hRad(EPS_MASK, EPS_WALL, tc, TwC);
        // mask resistance only over the masked part of the free side
        const mf = fArr[c] * maskFrac + (1 - fArr[c]);
        hcF[c] = mf / (1 / hF + maskR) + (1 - mf) * hF;
        hrF[c] = hRad(epsF[c], EPS_WALL, tf, TwF);
      }
      const tk = T[iK];
      hpC = faceH(tk - TaC, compUp, Math.max(gapC - o.bodyT, 1e-3)) * Abody;
      hpR = hRad(EPS_PKG, EPS_WALL, tk, TwC) * Abody;
    }

    // Matrix-free operator: the structure is a fixed 5-point stencil per sheet plus
    // the through-thickness link, the junction, the package top and the two walls.
    const gzc = new Float64Array(nc), jl = new Float64Array(nc);
    let sumArr = 0;
    for (let c = 0; c < nc; c++) sumArr += fArr[c];
    let jlSum = 0;
    for (let c = 0; c < nc; c++) {
      gzc[c] = fArr[c] * gzArr + (1 - fArr[c]) * gzFr4;
      jl[c] = fArr[c] / sumArr / o.Rjb; jlSum += jl[c];
    }
    const gWC = new Float64Array(nc), gWF = new Float64Array(nc), gAC = new Float64Array(nc), gAF = new Float64Array(nc);
    const diag = new Float64Array(n), rhs = new Float64Array(n);
    const convToWall = conf && !(hfan > 0);
    const gRjt = 1 / o.Rjt;
    let pW = 0, pA = 0;
    function build() {
      let sWC = 0, sWF = 0;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const cC = hcC[c] * Ac, rC = hrC[c] * Ac, cF = hcF[c] * Ac, rF = hrF[c] * Ac;
        gWC[c] = (convToWall ? cC : 0) + (conf ? rC : 0); gAC[c] = (convToWall ? 0 : cC) + (conf ? 0 : rC);
        gWF[c] = (convToWall ? cF : 0) + (conf ? rF : 0); gAF[c] = (convToWall ? 0 : cF) + (conf ? 0 : rF);
        const lat = gx * ((i > 0) + (i < nx - 1)) + gy * ((j > 0) + (j < ny - 1));
        diag[c] = lat + gzc[c] + gWC[c] + gAC[c] + jl[c]; rhs[c] = gAC[c] * Tamb;
        diag[nc + c] = lat + gzc[c] + gWF[c] + gAF[c]; rhs[nc + c] = gAF[c] * Tamb;
        sWC += gWC[c]; sWF += gWF[c];
      }
      pW = (convToWall ? hpC : 0) + (conf ? hpR : 0); pA = (convToWall ? 0 : hpC) + (conf ? 0 : hpR);
      diag[iJ] = jlSum + gRjt; rhs[iJ] = o.P;
      diag[iK] = gRjt + pW + pA; rhs[iK] = pA * Tamb;
      const eC = conf ? o.hExt * AwC : 1, eF = conf ? o.hExt * AwF : 1;
      diag[iWC] = sWC + pW + eC; rhs[iWC] = eC * Tamb;
      diag[iWF] = sWF + eF; rhs[iWF] = eF * Tamb;
    }
    function matvec(x, y) {
      const xWC = x[iWC], xWF = x[iWF], xJ = x[iJ];
      let sWC = 0, sWF = 0, sJ = 0;
      for (let j = 0; j < ny; j++) {
        const r0 = j * nx;
        for (let i = 0; i < nx; i++) {
          const c = r0 + i, f = nc + c, xc = x[c], xf = x[f];
          let a = diag[c] * xc - gzc[c] * xf - gWC[c] * xWC - jl[c] * xJ;
          let b = diag[f] * xf - gzc[c] * xc - gWF[c] * xWF;
          if (i > 0) { a -= gx * x[c - 1]; b -= gx * x[f - 1]; }
          if (i < nx - 1) { a -= gx * x[c + 1]; b -= gx * x[f + 1]; }
          if (j > 0) { a -= gy * x[c - nx]; b -= gy * x[f - nx]; }
          if (j < ny - 1) { a -= gy * x[c + nx]; b -= gy * x[f + nx]; }
          y[c] = a; y[f] = b;
          sWC += gWC[c] * xc; sWF += gWF[c] * xf; sJ += jl[c] * xc;
        }
      }
      y[iJ] = diag[iJ] * xJ - sJ - gRjt * x[iK];
      y[iK] = diag[iK] * x[iK] - gRjt * xJ - pW * xWC;
      y[iWC] = diag[iWC] * xWC - sWC - pW * x[iK];
      y[iWF] = diag[iWF] * xWF - sWF;
    }
    const rr = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    function pcg(x, tol, maxIt) {
      matvec(x, Ap);
      let bn = 0;
      for (let a = 0; a < n; a++) { rr[a] = rhs[a] - Ap[a]; z[a] = rr[a] / diag[a]; p[a] = z[a]; bn += rhs[a] * rhs[a]; }
      bn = Math.sqrt(bn) || 1;
      let rz = 0;
      for (let a = 0; a < n; a++) rz += rr[a] * z[a];
      let it = 0;
      for (; it < maxIt; it++) {
        matvec(p, Ap);
        let pAp = 0;
        for (let a = 0; a < n; a++) pAp += p[a] * Ap[a];
        const al = rz / pAp;
        let rn = 0;
        for (let a = 0; a < n; a++) { x[a] += al * p[a]; rr[a] -= al * Ap[a]; rn += rr[a] * rr[a]; }
        if (Math.sqrt(rn) / bn < tol) break;
        let rz2 = 0;
        for (let a = 0; a < n; a++) { z[a] = rr[a] / diag[a]; rz2 += rr[a] * z[a]; }
        const be = rz2 / rz; rz = rz2;
        for (let a = 0; a < n; a++) p[a] = z[a] + be * p[a];
      }
      return it;
    }

    let outer = 0, cgIts = 0;
    // initial guess: a rough lumped estimate so the first h values are sensible
    for (let a = 0; a < n; a++) T[a] = Tamb + 5;
    T[iJ] = Tamb + 20;
    for (; outer < 60; outer++) {
      updateH();
      build();
      const prev = T.slice();
      cgIts += pcg(T, o.cgTol || 1e-7, 4000);
      let md = 0;
      for (let a = 0; a < n; a++) md = Math.max(md, Math.abs(T[a] - prev[a]));
      if (md < (o.picardTol || 2e-3) && outer > 1) break;
    }

    // ---- heat-flow bookkeeping (W)
    const TwC = conf ? T[iWC] : Tamb, TwF = conf ? T[iWF] : Tamb;
    const TaC = hfan > 0 || !conf ? Tamb : TwC, TaF = hfan > 0 || !conf ? Tamb : TwF;
    const flow = { compConv: 0, compRad: 0, freeConv: 0, freeRad: 0, arrFreeConv: 0, arrFreeRad: 0,
      holeConv: 0, holeRad: 0, throughArr: 0, throughBarrels: 0, throughFill: 0, throughFr4Arr: 0, throughFr4Rest: 0 };
    let padMean = 0, sumA = 0, Tmax = -Infinity, TfreeArr = 0;
    // local heat flux per cell (W/m²), for drawing: convection / radiation off each face, and through the board
    const qConvC = new Float32Array(nc), qRadC = new Float32Array(nc), qConvF = new Float32Array(nc), qRadF = new Float32Array(nc), qZ = new Float32Array(nc);
    for (let c = 0; c < nc; c++) {
      const tc = T[c], tf = T[nc + c];
      flow.compConv += hcC[c] * Ac * (tc - TaC);
      flow.compRad += hrC[c] * Ac * (tc - TwC);
      const qc = hcF[c] * Ac * (tf - TaF), qr = hrF[c] * Ac * (tf - TwF);
      qConvC[c] = hcC[c] * (tc - TaC); qRadC[c] = hrC[c] * (tc - TwC);
      qConvF[c] = qc / Ac; qRadF[c] = qr / Ac; qZ[c] = gzc[c] * (tc - tf) / Ac;
      flow.freeConv += qc; flow.freeRad += qr;
      const dz = tc - tf;
      if (fArr[c] > 0) {
        const a = fArr[c];
        // split the free-side loss of the array cells by area / emissivity
        flow.arrFreeConv += a * qc;
        flow.arrFreeRad += qr * a * epsArrFree / epsF[c];
        const hF = faceH(tf - TaF, !compUp, gapF);
        flow.holeConv += a * Ac * holeFrac * hF * (tf - TaF);
        flow.holeRad += a * Ac * holeFrac * hRad(EPS_HOLE, EPS_WALL, tf, TwF) * (tf - TwF);
        const gz = a * gzArr;
        flow.throughArr += gz * dz;
        if (arr) {
          flow.throughBarrels += gz * dz * arr.Gbarrel / arr.G;
          flow.throughFill += gz * dz * arr.Gfill / arr.G;
          flow.throughFr4Arr += gz * dz * arr.Gfr4 / arr.G;
        }
        flow.throughFr4Rest += (1 - a) * gzFr4 * dz;
        padMean += a * tc; sumA += a; TfreeArr += a * tf;
      } else flow.throughFr4Rest += gzFr4 * dz;
      Tmax = Math.max(Tmax, tc, tf);
    }
    padMean /= sumA; TfreeArr /= sumA;
    const Pboard = (T[iJ] - padMean) / o.Rjb;
    const Ptop = (T[iJ] - T[iK]) / o.Rjt;
    const C = t => t - 273.15;
    return {
      o, arr, nx, ny, dx, dy,
      Tcomp: Float64Array.from(T.subarray(0, nc), C),
      Tfree: Float64Array.from(T.subarray(nc, 2 * nc), C),
      fArr, fBody, qConvC, qRadC, qConvF, qRadF, qZ,
      Tj: C(T[iJ]), Tpad: C(padMean), TfreeArr: C(TfreeArr), Tpkg: C(T[iK]), TwallC: C(TwC), TwallF: C(TwF),
      Tmax: C(Math.max(Tmax, T[iJ])),
      Pboard, Ptop, flow, outer, cgIts,
      holeFrac, padOpen, epsArrFree,
      balance: o.P - (flow.compConv + flow.compRad + flow.freeConv + flow.freeRad + hpC * (T[iK] - TaC) + hpR * (T[iK] - TwC)),
    };
  }

  // The four cases the question is about (tented / open x component up / down),
  // plus the selected case when its via treatment is neither.
  function compare(opts, onPartial) {
    const o = { ...DEFAULTS, ...opts };
    const opt = optimise(o);
    const out = {};
    const selected = o.side + '_' + o.via;
    if (!opt.best) return { opt, cases: out, selected: null };
    const one = (side, via) => { const oo = { ...o, side, via }; out[side + '_' + via] = solve(oo, arrayConductance(opt.best.d, oo)); };
    // the selected case first, so a caller can show it while the rest solve
    one(o.side, o.via);
    if (onPartial) onPartial({ opt, cases: { ...out }, selected, partial: true });
    const vias = ['tented', 'open'];
    if (!vias.includes(o.via)) vias.push(o.via);
    for (const side of ['top', 'bottom']) for (const via of vias) if (!out[side + '_' + via]) one(side, via);
    // reference: the same board with no vias in the pad (FR4 only)
    const oo = { ...o, via: 'tented' };
    const none = { ...arrayConductance(opt.best.d, oo), N: 0, Gbarrel: 0, Gfill: 0 };
    none.Gfr4 = K_FR4_Z * o.arrW * o.arrH / o.tb; none.G = none.Gfr4; none.R = 1 / none.G;
    out.noVias = solve(oo, none);
    return { opt, cases: out, selected };
  }

  const api = { DEFAULTS, FILL, viaConductance, layout, arrayConductance, drillCandidates, optimise, solve, compare,
    hUp, hDn, hForced, hRad, consts: { K_CU, K_FR4_Z, K_AIR, EPS_MASK, EPS_HOLE, T_MASK, K_MASK } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ViaModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
