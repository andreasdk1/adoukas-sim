// Thermal via array calculator: inputs -> ViaModel (in a worker when it can) -> views.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  if (!$('tv-xsec')) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const COL = { heat: '#f5a03c', heat2: '#ffd08a', ink: '#e8eefb', ink2: '#9eabc9', line: 'rgba(169,192,234,0.22)',
    board: '#2f6b3c', cu: '#c98a4b', mask: '#24563a', comp: '#2a3550', compEdge: '#5a80c8', wall: '#4a5677',
    bar: '#2f5cb4', barBest: '#a9c0ea', grid: 'rgba(169,192,234,0.12)' };

  // ------------------------------------------------------------------ inputs
  const NUM = ['arrW', 'arrH', 'dMin', 'ring', 'hole2hole', 'plating', 'body', 'Rjb', 'boardW', 'boardH', 'tb', 'gapUp', 'gapDn', 'cuMargin'];
  const defaults = {};
  for (const k of NUM) defaults[k] = $('i-' + k).value;
  for (const k of ['P', 'fan', 'Tamb', 'via', 'layers', 'cuComp', 'cuFree', 'cuInner']) defaults[k] = $('i-' + k).value;
  const num = (k, lo, hi) => {
    const el = $('i-' + k), v = parseFloat(el.value);
    if (!isFinite(v)) return null;
    return Math.min(hi, Math.max(lo, v));
  };
  function readOpts() {
    const mm = 1e-3;
    const v = {
      arrW: num('arrW', 0.5, 30), arrH: num('arrH', 0.5, 30), dMin: num('dMin', 0.1, 1), ring: num('ring', 0.05, 0.5),
      hole2hole: num('hole2hole', 0.1, 1), plating: num('plating', 10, 50), body: num('body', 1, 40), Rjb: num('Rjb', 0.1, 50),
      boardW: num('boardW', 10, 150), boardH: num('boardH', 10, 150), tb: num('tb', 0.4, 3.2), gapUp: num('gapUp', 2, 100), gapDn: num('gapDn', 2, 100),
      cuMargin: num('cuMargin', 0.5, 30),
    };
    for (const k in v) if (v[k] === null) return null;
    const P = +$('i-P').value, fan = +$('i-fan').value, Tamb = +$('i-Tamb').value;
    const side = document.querySelector('input[name="i-side"]:checked').value;
    const body = Math.max(v.body, Math.max(v.arrW, v.arrH));
    return {
      arrW: v.arrW * mm, arrH: v.arrH * mm, dMin: v.dMin * mm, ring: v.ring * mm, hole2hole: v.hole2hole * mm, plating: v.plating * 1e-6,
      bodyW: body * mm, bodyH: body * mm, Rjb: v.Rjb, P, side, via: $('i-via').value,
      boardW: Math.max(v.boardW, body + 2) * mm, boardH: Math.max(v.boardH, body + 2) * mm, tb: v.tb * mm, layers: +$('i-layers').value,
      enclosure: $('i-enclosure').checked, gapUp: v.gapUp * mm, gapDn: v.gapDn * mm, fan, Tamb,
      cuComp: $('i-cuComp').value, cuFree: $('i-cuFree').value, cuMargin: v.cuMargin * mm, cuInner: $('i-cuInner').value,
      grid: Math.max(0.5e-3, Math.max(v.boardW, v.boardH) * mm / 110),
    };
  }
  function labels() {
    $('i-P-v').textContent = (+$('i-P').value).toFixed(1) + ' W';
    const f = +$('i-fan').value;
    $('i-fan-v').textContent = f > 0 ? f.toFixed(1) + ' m/s' : 'off';
    $('i-Tamb-v').textContent = $('i-Tamb').value + ' °C';
    const enc = $('i-enclosure').checked;
    $('i-gapUp').disabled = $('i-gapDn').disabled = !enc;
    $('i-cuMargin').disabled = $('i-cuComp').value !== 'margin' && $('i-cuFree').value !== 'margin';
    $('i-cuInner').disabled = $('i-layers').value === '2';
  }

  // ------------------------------------------------------------------ solver
  let worker = null, reqId = 0, lastShown = 0, t0 = 0;
  try {
    const src = document.querySelector('script[src*="vias-model.js"]').src.replace('vias-model.js', 'vias-worker.js');
    worker = new Worker(src);
    worker.onmessage = e => {
      const m = e.data;
      if (m.id !== reqId) return;
      if (!m.ok) fail(m.error);
      else if (m.drills) showDrills(m.drills, m.partial);
      else show(m.r);
    };
    worker.onerror = () => { worker = null; schedule(); };
  } catch (e) { worker = null; }
  let timer = 0;
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 120); }
  function run() {
    labels();
    const o = readOpts();
    if (!o) { status('bad', 'Check the highlighted input.'); return; }
    status('busy', 'Solving…');
    reqId++; t0 = performance.now(); drillRows = null;
    if (worker) worker.postMessage({ id: reqId, opts: o });
    else {
      const id = reqId, cache = {};
      setTimeout(() => {
        if (id !== reqId) return;
        try { show(window.ViaModel.compare(o, null, cache)); } catch (err) { fail(err.message); return; }
        const next = window.ViaModel.drillSweep(o, cache), rows = [];
        const tick = () => { if (id !== reqId) return; const r = next(); if (r) { rows.push(r); setTimeout(tick, 0); } showDrills(rows.slice(), !!r); };
        setTimeout(tick, 0);
      }, 0);
    }
  }
  function status(kind, text) { const s = $('tv-status'); s.className = 'tv-status ' + kind; s.textContent = text; }
  function fail(msg) { status('bad', 'Solver error: ' + msg); }

  // -------------------------------------------------------------------- views
  let last = null;
  const fmtT = t => t.toFixed(1) + ' °C';
  const fmtW = w => (Math.abs(w) >= 0.1 ? w.toFixed(2) + ' W' : (w * 1000).toFixed(w * 1000 >= 10 ? 0 : 1) + ' mW');
  const mm = x => (x * 1e3).toFixed(2);
  const sideName = s => (s === 'top' ? 'Component on top' : 'Component underneath');
  const viaName = { tented: 'tented', open: 'open', plugged: 'plugged and capped', cufill: 'copper filled' };
  const cuName = (m, o) => (m === 'pad' ? 'pad only' : m === 'margin' ? `pad + ${(o.cuMargin * 1e3).toFixed(1)} mm` : 'plane');

  function show(r) {
    last = r;
    const ms = performance.now() - t0;
    if (!r.opt.best) {
      status('bad', 'No via fits the pad with these rules: make the pad larger or the drill and ring smaller.');
      return;
    }
    const s = r.cases[r.selected], b = r.opt.best;
    $('tv-case-label').textContent = (s.o.side === 'top' ? 'part on top' : 'part underneath') + ' · ' + viaName[s.o.via];
    $('tv-r-cu').textContent = `${cuName(s.o.cuComp, s.o)} · ${cuName(s.o.cuFree, s.o)}`;
    $('tv-tj').textContent = fmtT(s.Tj);
    $('tv-k-array').textContent = `${b.m} × ${b.n}`;
    $('tv-k-array-s').textContent = `Ø${mm(b.d)} at ${mm(b.pitch)} mm`;
    $('tv-r-drill').textContent = `${mm(b.d)} · ${mm(b.pitch)} mm · ${b.m} × ${b.n} = ${b.N}`;
    const Rarr = s.arr.R;
    const Rja = (s.Tj - s.o.Tamb) / s.o.P;
    $('tv-r-rarr').textContent = `${(100 * Rarr / Rja).toFixed(0)} %`;
    $('tv-r-rarr-s').textContent = `${Rarr.toFixed(Rarr < 10 ? 2 : 1)} of ${Rja.toFixed(1)} K/W`;
    $('tv-r-rja').textContent = ((s.Tj - s.o.Tamb) / s.o.P).toFixed(1) + ' K/W';
    $('tv-r-novia').textContent = r.partial ? '…' : '+' + (r.cases.noVias.Tj - r.cases[s.o.side + '_tented'].Tj).toFixed(1) + ' K';
    if (!r.partial) {
      const d = r.cases[s.o.side + '_open'].Tj - r.cases[s.o.side + '_tented'].Tj;
      const rise = r.cases[s.o.side + '_tented'].Tj - s.o.Tamb;
      $('tv-k-tent').textContent = `${(d >= 0 ? '+' : '−')}${(100 * Math.abs(d) / rise).toFixed(2)} %`;
      $('tv-k-tent-s').textContent = `of the rise, ${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} K`;
    } else $('tv-k-tent').textContent = '…';
    if (s.o.enclosure) {
      const up = s.o.side === 'top' ? s.TwallC : s.TwallF, dn = s.o.side === 'top' ? s.TwallF : s.TwallC;
      $('tv-r-walls').textContent = 'lid ' + up.toFixed(1) + ' · floor ' + dn.toFixed(1) + ' °C';
    } else $('tv-r-walls').textContent = 'none (open room)';
    const limit = 125;
    if (r.partial) status('busy', 'Comparing cases…');
    else if (s.Tj > limit) status('bad', `Above a ${limit} °C design limit`);
    else status('ok', `Solved in ${ms.toFixed(0)} ms`);
    colourScale(s);
    if (!r.partial) table(r);
    chart(r);
    why(r);
    xsec(s);
    show3d(s);
    buildXsGlow();
    radTotals();
    if (!$('tv-board').hidden) maps(s); else mapState = { s };
  }

  function table(r) {
    const sel = r.selected;
    for (const tr of document.querySelectorAll('#tv-table tbody tr')) {
      const side = tr.dataset.side, t = r.cases[side + '_tented'], o = r.cases[side + '_open'];
      const td = tr.querySelectorAll('td');
      td[0].textContent = fmtT(t.Tj); td[1].textContent = fmtT(o.Tj);
      const d = o.Tj - t.Tj;
      td[2].textContent = (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2) + ' K';
      td[2].className = 'delta';
      td[0].classList.toggle('sel', sel === side + '_tented');
      td[1].classList.toggle('sel', sel === side + '_open');
    }
    const s = r.cases[r.selected], P = s.o.P;
    const op = r.cases[s.o.side + '_open'], holes = op.flow.holeConv + op.flow.holeRad;
    const tt = r.cases.top_tented.Tj, bt = r.cases.bottom_tented.Tj;
    $('tv-r-holes').textContent = `${fmtW(holes)} of ${P.toFixed(1)} W (${(100 * holes / P).toFixed(2)} %)`;
    void tt; void bt;
  }

  // ---- drill chart (SVG bars, hover tooltip)
  const chartEl = $('tv-chart');
  const tip = document.createElement('div'); tip.className = 'tv-tip'; tip.hidden = true; chartEl.appendChild(tip);
  function el(name, attrs, parent) {
    const e = document.createElementNS(SVGNS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  // Two panels on one drill axis: the junction temperature with the most vias of each drill
  // (solved for every drill, arriving after the main result) and the array resistance.
  let drillRows = null, lastR = null;
  function showDrills(rows, partial) {
    drillRows = { rows, partial };
    if (lastR) { chart(lastR); why(lastR); }
  }
  function chart(r) {
    lastR = r;
    const rows = r.opt.rows, best = r.opt.best;
    const W = 640, H = 300, L = 46, R = 10;
    const tT = 28, tB = 138, bT = 166, bB = 238, xl = 256;         // top panel, bottom panel, x labels
    const old = chartEl.querySelector('svg'); if (old) old.remove();
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    chartEl.insertBefore(svg, tip);
    const n = rows.length, bw = (W - L - R) / n, w = Math.max(4, Math.min(24, bw - 8));
    const X = i => L + bw * (i + 0.5);
    const tj = new Map();
    if (drillRows) for (const d of drillRows.rows) tj.set(d.d.toFixed(6), d.Tj);
    const T = row => tj.get(row.d.toFixed(6));
    // top: junction temperature
    const known = rows.map(T).filter(v => v !== undefined);
    el('text', { x: L, y: 12, 'font-size': 10, fill: COL.ink2 }, svg).textContent = 'junction, °C';
    if (known.length) {
      let lo = Math.min(...known), hi = Math.max(...known);
      const pad = Math.max(0.5, (hi - lo) * 0.15); lo -= pad; hi += pad;
      const step = niceStep((hi - lo) / 3), yT = v => tB - (tB - tT) * (v - lo) / (hi - lo);
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        el('line', { x1: L, x2: W - R, y1: yT(v), y2: yT(v), stroke: COL.grid, 'stroke-width': 1 }, svg);
        el('text', { x: L - 8, y: yT(v) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: COL.ink2 }, svg).textContent = +v.toFixed(2);
      }
      let d = '';
      rows.forEach((row, i) => { const v = T(row); if (v !== undefined) d += (d ? ' L' : 'M') + X(i).toFixed(1) + ',' + yT(v).toFixed(1); });
      el('path', { d, fill: 'none', stroke: COL.heat, 'stroke-width': 1.6, opacity: 0.8 }, svg);
      rows.forEach((row, i) => {
        const v = T(row); if (v === undefined) return;
        const isBest = row === best;
        el('circle', { cx: X(i), cy: yT(v), r: isBest ? 5 : 3.2, fill: isBest ? '#fff0be' : COL.heat, stroke: '#0c1531', 'stroke-width': 1.5 }, svg);
        if (isBest) {
          // below the dot (the chosen drill sits at or near the lowest point), above it if there is no room
          const yl = yT(v) + 17 <= tB + 12 ? yT(v) + 17 : yT(v) - 10;
          const lab = el('text', { x: X(i), y: yl, 'text-anchor': i > n - 3 ? 'end' : i < 2 ? 'start' : 'middle', 'font-size': 10.5, fill: COL.ink }, svg);
          lab.setAttribute('paint-order', 'stroke'); lab.setAttribute('stroke', '#0c1531'); lab.setAttribute('stroke-width', 4);
          lab.textContent = `${v.toFixed(1)} °C`;
        }
      });
    } else el('text', { x: (L + W - R) / 2, y: (tT + tB) / 2, 'text-anchor': 'middle', 'font-size': 11, fill: COL.ink2 }, svg).textContent = 'solving each drill…';
    // bottom: array resistance
    const maxR = Math.max(...rows.map(x => x.R)) * 1.1, yR = v => bB - (bB - bT) * v / maxR;
    el('text', { x: L, y: bT - 8, 'font-size': 10, fill: COL.ink2 }, svg).textContent = 'array, K/W';
    const stepR = niceStep(maxR / 2);
    for (let v = stepR; v <= maxR + 1e-9; v += stepR) {
      el('line', { x1: L, x2: W - R, y1: yR(v), y2: yR(v), stroke: COL.grid, 'stroke-width': 1 }, svg);
      el('text', { x: L - 8, y: yR(v) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: COL.ink2 }, svg).textContent = +v.toFixed(3);
    }
    const every = n > 12 ? 2 : 1;
    rows.forEach((row, i) => {
      const cx = X(i), isBest = row === best, top = yR(row.R), h = bB - top, rad = Math.min(3, w / 2, h);
      el('path', { d: `M${cx - w / 2},${bB} V${top + rad} Q${cx - w / 2},${top} ${cx - w / 2 + rad},${top} H${cx + w / 2 - rad} Q${cx + w / 2},${top} ${cx + w / 2},${top + rad} V${bB} Z`,
        fill: isBest ? COL.barBest : COL.bar }, svg);
      // x labels: drill, and the array below it where the count changes
      if (i % every === 0 || isBest)
        el('text', { x: cx, y: xl, 'text-anchor': 'middle', 'font-size': 10, fill: isBest ? COL.ink : COL.ink2 }, svg).textContent = (row.d * 1e3).toFixed(2);
      if (i === 0 || rows[i - 1].N !== row.N)
        el('text', { x: cx, y: xl + 15, 'text-anchor': 'middle', 'font-size': 10, fill: isBest ? COL.ink : COL.ink2 }, svg).textContent = `${row.m}×${row.n}`;
      const hit = el('rect', { x: cx - bw / 2, y: tT - 10, width: bw, height: bB - tT + 10, fill: 'transparent' }, svg);
      const enter = () => {
        const v = T(row), vb = T(best);
        tip.hidden = false;
        tip.innerHTML = `<b>${(row.d * 1e3).toFixed(2)} mm drill</b>${isBest ? ' <span>· chosen</span>' : ''}<br><span>pitch</span> ${(row.pitch * 1e3).toFixed(2)} mm<br>` +
          `<span>vias</span> ${row.m} × ${row.n} = ${row.N}<br><span>array</span> ${row.R.toFixed(2)} K/W` +
          (v !== undefined ? `<br><span>junction</span> ${v.toFixed(1)} °C` + (!isBest && vb !== undefined ? ` <span>(${v - vb >= 0 ? '+' : '−'}${Math.abs(v - vb).toFixed(2)} K)</span>` : '') : '');
        const box = svg.getBoundingClientRect(), sc = box.width / W;
        tip.style.left = (cx * sc) + 'px'; tip.style.top = ((v !== undefined ? tT : bT) * sc) + 'px';
      };
      hit.addEventListener('pointerenter', enter);
      hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    });
    el('line', { x1: L, x2: W - R, y1: bB, y2: bB, stroke: COL.ink2, 'stroke-width': 1 }, svg);
    el('text', { x: W - R, y: H - 2, 'text-anchor': 'end', 'font-size': 10, fill: COL.ink2 }, svg).textContent = 'drill, mm · vias';
  }
  // Why this drill: the pitch rule, the copper per area, the whole-row steps, and what it is worth.
  function why(r) {
    const b = r.opt.best, s = r.cases[r.selected], o = s.o, f = x => (x * 1e3).toFixed(2), rows = r.opt.rows;
    const c = b.pitch - b.d, ringRule = 2 * o.ring + (o.padGap || 0) >= o.hole2hole;
    const parts = [];
    parts.push(`Pitch = drill + ${f(c)} mm here (${ringRule ? `two annular rings of ${f(o.ring)} mm` : `the ${f(o.hole2hole)} mm hole-to-hole rule`}).`);
    if (o.via === 'cufill') parts.push(`A filled via conducts through its whole section, so copper per area grows with the drill: the largest drill that keeps the row count wins.`);
    else {
      const dStar = c + 2 * o.plating;
      parts.push(`A plated via conducts through its barrel, so copper per area goes as (d − t)/(d + ${f(c)})², highest at d = ${f(dStar)} mm; smaller drills do not help.`);
    }
    const i = rows.indexOf(b), nxt = rows[i + 1];
    parts.push(`Only whole rows fit the ${(o.arrW * 1e3).toFixed(1)} × ${(o.arrH * 1e3).toFixed(1)} mm pad, which makes the curve saw-toothed: Ø${f(b.d)} gives ${b.m} × ${b.n}` +
      (nxt && nxt.N < b.N ? `, and the next drill drops to ${nxt.m} × ${nxt.n}.` : '.'));
    if (drillRows && !drillRows.partial) {
      const ts = drillRows.rows.map(x => x.Tj), lo = Math.min(...ts), hi = Math.max(...ts);
      parts.push(`Across all drills the junction moves by ${(hi - lo).toFixed(1)} K (${(100 * (hi - lo) / (s.Tj - o.Tamb)).toFixed(0)} % of the rise).`);
    }
    $('tv-why').textContent = parts.join(' ');
  }
  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  // ---- cross-section: widths to scale, thicknesses exaggerated; separate convection and
  // radiation arrows; animated flow (CSS dash animation) along every path
  function xsec(s) {
    const svg = $('tv-xsec');
    svg.setAttribute('viewBox', '0 0 760 440');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const o = s.o, f = s.flow, P = o.P, up = o.side === 'top', mm = 1e3;
    const x0 = 30, x1 = 730, lid = 46, floor = 394;
    const tB = Math.max(10, Math.min(30, o.tb * mm * 11));            // board thickness, exaggerated
    const gu = o.enclosure ? o.gapUp : 0.02, gd = o.enclosure ? o.gapDn : 0.02;
    let yb = lid + (floor - lid - tB) * gu / (gu + gd);
    yb = Math.min(floor - tB - 125, Math.max(lid + 125, yb));
    const ybb = yb + tB;
    const defs = el('defs', {}, svg);
    for (const [id, col] of [['tv-ah', COL.heat], ['tv-ahr', '#fff0be']]) {
      const mk = el('marker', { id, viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: 3, markerHeight: 3, orient: 'auto-start-reverse', markerUnits: 'strokeWidth' }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 z', fill: col }, mk);
    }
    const md = el('marker', { id: 'tv-dim', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M0,1 L10,5 L0,9', fill: 'none', stroke: COL.ink2, 'stroke-width': 1.2 }, md);

    // horizontal scale: the board spans the enclosure, mm -> px
    const bx0 = 70, bx1 = 690, cx = (bx0 + bx1) / 2, kx = (bx1 - bx0) / (o.boardW * mm);
    // enclosure
    if (o.enclosure) {
      const tl = up ? s.TwallC : s.TwallF, tf = up ? s.TwallF : s.TwallC;
      for (const [x, y, w, h, c] of [[x0 - 8, lid - 8, x1 - x0 + 16, 8, tcol(tl)], [x0 - 8, floor, x1 - x0 + 16, 8, tcol(tf)],
        [x0 - 8, lid - 8, 8, floor - lid + 16, COL.wall], [x1, lid - 8, 8, floor - lid + 16, COL.wall]])
        el('rect', { x, y, width: w, height: h, fill: c, rx: 2 }, svg);
      txt(x1 - 8, lid + 16, `lid ${tl.toFixed(1)} °C`, 'end', COL.ink2);
      txt(x1 - 8, floor - 8, `floor ${tf.toFixed(1)} °C`, 'end', COL.ink2);
      txt(x0 + 8, lid + 16, `${(o.gapUp * mm).toFixed(0)} mm air`, 'start', COL.ink2);
      txt(x0 + 8, floor - 8, `${(o.gapDn * mm).toFixed(0)} mm air`, 'start', COL.ink2);
      if (o.fan > 0) txt((x0 + x1) / 2, lid - 16, 'vented: convection goes to the room air, the walls take radiation', 'middle', COL.ink2);
      else {
        const qLid = up ? f.compConv + f.compRad + s.Ptop : f.freeConv + f.freeRad;
        txt((x0 + x1) / 2, lid - 16, `lid → room ${fmtW(qLid)}`, 'middle', COL.ink2);
        txt((x0 + x1) / 2, floor + 28, `floor → room ${fmtW(P - qLid)}`, 'middle', COL.ink2);
      }
    } else txt(x0 + 8, lid + 16, 'open room, no enclosure', 'start', COL.ink2);
    // gravity
    const gx = x0 + 18, gy = (lid + floor) / 2 - 18;
    el('line', { x1: gx, y1: gy, x2: gx, y2: gy + 34, stroke: COL.ink2, 'stroke-width': 1.5 }, svg);
    el('path', { d: `M${gx - 4},${gy + 28} L${gx},${gy + 36} L${gx + 4},${gy + 28}`, fill: 'none', stroke: COL.ink2, 'stroke-width': 1.5 }, svg);
    txt(gx + 8, gy + 22, 'g', 'start', COL.ink2, 'italic');

    // board coloured by the temperature along its centre line, each face its own colour
    const jm = (s.ny / 2) | 0;
    const gradOf = (id, T) => {
      const gr = el('linearGradient', { id, x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
      for (let k = 0; k <= 32; k++) {
        const i = Math.min(s.nx - 1, Math.round(k / 32 * (s.nx - 1)));
        el('stop', { offset: (k / 32).toFixed(3), 'stop-color': tcol(T[jm * s.nx + i]) }, gr);
      }
    };
    gradOf('tv-gu', up ? s.Tcomp : s.Tfree); gradOf('tv-gl', up ? s.Tfree : s.Tcomp);
    el('rect', { x: bx0, y: yb, width: bx1 - bx0, height: tB / 2, fill: 'url(#tv-gu)' }, svg);
    el('rect', { x: bx0, y: yb + tB / 2, width: bx1 - bx0, height: tB / 2, fill: 'url(#tv-gl)' }, svg);
    el('rect', { x: bx0, y: yb, width: bx1 - bx0, height: tB, fill: 'none', stroke: 'rgba(232,238,251,0.25)' }, svg);
    // copper connected to the array on each face, to scale
    const cuSpan = m => {
      if (m === 'plane') return [bx0, bx1];
      const e = (m === 'margin' ? o.cuMargin : 0) * mm;
      return [cx - (o.arrW * mm / 2 + e) * kx, cx + (o.arrW * mm / 2 + e) * kx];
    };
    for (const [m, y] of [[up ? o.cuComp : o.cuFree, yb], [up ? o.cuFree : o.cuComp, ybb - 2.5]]) {
      const [a0, a1] = cuSpan(m);
      el('rect', { x: a0, y, width: a1 - a0, height: 2.5, fill: COL.cu, opacity: m === 'plane' ? 0.75 : 1 }, svg);
    }

    // array and vias to scale (every via of the centre row)
    const a = s.arr, aw = o.arrW * mm * kx, ax0 = cx - aw / 2;
    const pitchPx = a.pitch * mm * kx, dPx = Math.max(1.5, a.d * mm * kx), x0v = cx - (a.m - 1) * pitchPx / 2;
    for (let i = 0; i < a.m; i++) {
      const vx = x0v + i * pitchPx;
      el('rect', { x: vx - dPx / 2, y: yb, width: dPx, height: tB, fill: COL.cu }, svg);
      if (o.via !== 'cufill' && dPx > 3) el('rect', { x: vx - dPx / 2 + 1, y: yb, width: dPx - 2, height: tB, fill: o.via === 'plugged' ? '#8a8f9c' : '#0b1430' }, svg);
      // heat running down (or up) the barrel
      el('line', { x1: vx, x2: vx, y1: up ? yb + 1 : ybb - 1, y2: up ? ybb - 1 : yb + 1, stroke: '#ffe2a8', 'stroke-width': Math.max(1, Math.min(2.5, dPx / 3)), class: 'tv-flowline tv-fast' }, svg);
    }
    const yFree = up ? ybb : yb - 2;
    if (o.via === 'open') for (let i = 0; i < a.m; i++) el('rect', { x: x0v + i * pitchPx - a.pad * mm * kx / 2, y: yFree, width: a.pad * mm * kx, height: 2, fill: COL.cu }, svg);
    else el('rect', { x: ax0, y: yFree, width: aw, height: 2, fill: o.via === 'tented' ? '#3f8a5a' : COL.cu }, svg);

    // component to scale in width, see-through
    const cw = Math.max(o.bodyW, o.arrW) * mm * kx, ch = Math.max(8, Math.min(22, o.bodyT * mm * 11)), cy0 = up ? yb - ch - 2 : ybb + 2;
    el('rect', { x: ax0, y: up ? yb - 2 : ybb, width: aw, height: 2, fill: '#b9bcc4' }, svg);   // solder on the pad
    el('rect', { x: cx - cw / 2, y: cy0, width: cw, height: ch, fill: tcol(s.Tpkg, 0.6), stroke: COL.compEdge, 'stroke-width': 1, rx: 2 }, svg);
    // component callout, clear of the arrows
    const yCall = up ? cy0 - 70 : cy0 + ch + 78, xCall = cx - cw / 4;
    el('line', { x1: xCall, x2: xCall, y1: up ? cy0 : cy0 + ch, y2: up ? yCall + 5 : yCall - 15, stroke: 'rgba(232,238,251,0.5)', 'stroke-width': 1 }, svg);
    const cl = txt(xCall, yCall, `${P.toFixed(1)} W · Tj ${s.Tj.toFixed(1)} °C`, 'middle', '#fff', null, 12.5);
    cl.setAttribute('paint-order', 'stroke'); cl.setAttribute('stroke', '#0c1531'); cl.setAttribute('stroke-width', 6);

    const wOf = q => 1.5 + 16 * Math.max(0, q) / P;
    const dirC = up ? -1 : 1, L = 54;
    const lx = 130, rx = 630;
    // a pair of arrows: convection (orange) and radiation (pale), side by side
    const pair = (xc, y0, dir, qc, qr) => {
      arrow(xc - 7, y0, xc - 7, y0 + dir * L, wOf(qc), false);
      arrow(xc + 7, y0, xc + 7, y0 + dir * L, wOf(qr), true);
    };
    // component side, away from the package
    const yc0 = up ? yb - 3 : ybb + 3;
    pair(lx, yc0, dirC, f.compConv / 2, f.compRad / 2);
    pair(rx, yc0, dirC, f.compConv / 2, f.compRad / 2);
    const ycl = yc0 + dirC * (L / 2) + 4;
    txt(lx + 22, ycl - 6, `${fmtW(f.compConv + f.compRad)} board, component side`, 'start');
    txt(lx + 22, ycl + 8, `conv ${fmtW(f.compConv)} · rad ${fmtW(f.compRad)}`, 'start', COL.ink2, null, 10.5);
    // package top
    const yp0 = up ? cy0 - 3 : cy0 + ch + 3, xp = cx + cw / 4;
    arrow(xp, yp0, xp, yp0 + dirC * (L - 10), wOf(s.Ptop), false);
    txt(xp + 12, yp0 + dirC * (L - 10) / 2 + 4, `package top ${fmtW(s.Ptop)}`, 'start');
    // through the array
    const tl2 = txt(ax0 - 10, yb + tB / 2 + 4, `${up ? '↓' : '↑'} ${fmtW(f.throughArr)} through the vias`, 'end', '#ffe2a8', null, 11);
    tl2.setAttribute('paint-order', 'stroke'); tl2.setAttribute('stroke', 'rgba(12,21,49,0.85)'); tl2.setAttribute('stroke-width', 5);
    // free side: rest of the board and the array area
    const arrConv = f.arrFreeConv, arrRad = f.arrFreeRad;
    const restConv = f.freeConv - arrConv, restRad = f.freeRad - arrRad;
    const yf0 = up ? ybb + 3 : yb - 3, dirF = -dirC;
    pair(lx, yf0, dirF, restConv / 2, restRad / 2);
    pair(rx, yf0, dirF, restConv / 2, restRad / 2);
    pair(cx, yf0, dirF, arrConv, arrRad);
    const yfl = yf0 + dirF * (L / 2) + 4;
    txt(lx + 22, yfl - 6, `${fmtW(restConv + restRad)} rest of the free side`, 'start');
    txt(lx + 22, yfl + 8, `conv ${fmtW(restConv)} · rad ${fmtW(restRad)}`, 'start', COL.ink2, null, 10.5);
    const holes = f.holeConv + f.holeRad;
    txt(cx + 22, yfl - 6, `${fmtW(arrConv + arrRad)} from the array area`, 'start');
    txt(cx + 22, yfl + 8, o.via === 'open' ? `open holes: ${fmtW(holes)}` : `${viaName[o.via]}: no open holes`, 'start', COL.ink2, null, 10.5);
    // width dimension
    const yd = up ? ybb + 98 : yb - 98;
    const dimTxt = `board ${(o.boardW * mm).toFixed(0)} × ${(o.boardH * mm).toFixed(0)} × ${(o.tb * mm).toFixed(1)} mm · pad ${(o.arrW * mm).toFixed(1)} mm · ${a.m} vias across`;
    const half = dimTxt.length * 6.7 / 2 + 8;      // monospace 11 px: leave a gap in the line for the label
    el('line', { x1: bx0, x2: cx - half, y1: yd, y2: yd, stroke: COL.ink2, 'stroke-width': 1, 'marker-start': 'url(#tv-dim)' }, svg);
    el('line', { x1: cx + half, x2: bx1, y1: yd, y2: yd, stroke: COL.ink2, 'stroke-width': 1, 'marker-end': 'url(#tv-dim)' }, svg);
    txt(cx, yd + 4, dimTxt, 'middle', COL.ink2, null, 11);

    XS = { s, o, up, bx0, bx1, kx, yb, ybb, tB, lid, floor, x0, x1, cx, cw, ch, cy0, ax0, aw,
      viaXs: Array.from({ length: a.m }, (_, i) => x0v + i * pitchPx) };

    function arrow(xa, ya, xb, yb2, w, radn) {
      el('line', { x1: xa, y1: ya, x2: xb, y2: yb2, stroke: radn ? '#fff0be' : COL.heat, 'stroke-width': w, 'marker-end': `url(#${radn ? 'tv-ahr' : 'tv-ah'})`, opacity: radn ? 0.8 : 0.9,
        class: 'tv-flowline' + (radn ? ' tv-fast' : '') }, svg);
    }
    function txt(x, y, s2, anchor, fill, style, size) {
      const t = el('text', { x, y, 'text-anchor': anchor || 'start', 'font-size': size || 12, fill: fill || COL.ink }, svg);
      if (style) t.setAttribute('font-style', style);
      t.textContent = s2;
      return t;
    }
  }

  // ---- cross-section animation: particles for convection and conduction, glow for radiation.
  // Drawn on a canvas behind the SVG, in the SVG's own viewBox units (760 × 440).
  let XS = null, xsParts = [], xsGlow = null, xsRun = false, xsLast = 0, xsClock = 0, heatMode = 'all';
  const xsCv = $('tv-xsec-fx'), xsCtx = xsCv.getContext('2d');
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function centreRow(arr) { const s = XS.s, j = (s.ny / 2) | 0; return Array.from({ length: s.nx }, (_, i) => arr[j * s.nx + i]); }
  function xsProfiles() {
    const s = XS.s, up = XS.up;
    return {
      TU: centreRow(up ? s.Tcomp : s.Tfree), TL: centreRow(up ? s.Tfree : s.Tcomp),
      cU: centreRow(up ? s.qConvC : s.qConvF), cL: centreRow(up ? s.qConvF : s.qConvC),
      rU: centreRow(up ? s.qRadC : s.qRadF), rL: centreRow(up ? s.qRadF : s.qRadC),
    };
  }
  function cdf1(q) { const c = []; let t = 0; for (const v of q) { t += Math.max(0, v); c.push(t); } return { c, t }; }
  function pick1(d) { const r = Math.random() * d.t; let i = 0; while (i < d.c.length - 1 && d.c[i] < r) i++; return i; }
  // radiation glow, pre-rendered once per solution
  function buildXsGlow() {
    if (!XS) return;
    XS.prof = xsProfiles();
    XS.dU = cdf1(XS.prof.cU); XS.dL = cdf1(XS.prof.cL);
    const rad = view3d.radiation();
    const c = document.createElement('canvas'); c.width = 760; c.height = 440;
    const x = c.getContext('2d');
    const qmax = rad && rad.qmax ? rad.qmax : 1;
    const aFace = q => 0.85 * Math.pow(Math.max(0, q) / qmax, 2.2);    // a little stronger than in 3D: the bands are thin
    const nx = XS.s.nx;
    // one smooth band: a strip of alpha values stretched along the edge, faded away from it
    const strip = (alphas, x0, y0, w, h, horizontal, fadeTowards) => {
      const n = alphas.length;
      const src = document.createElement('canvas');
      src.width = horizontal ? n : 1; src.height = horizontal ? 1 : n;
      const sx = src.getContext('2d'), im = sx.createImageData(src.width, src.height);
      alphas.forEach((al, i) => { const p = i * 4; im.data[p] = 255; im.data[p + 1] = 236; im.data[p + 2] = 190; im.data[p + 3] = 255 * Math.min(1, al); });
      sx.putImageData(im, 0, 0);
      const bandC = document.createElement('canvas'); bandC.width = Math.max(1, Math.round(w)); bandC.height = Math.max(1, Math.round(h));
      const bx = bandC.getContext('2d');
      bx.imageSmoothingEnabled = true;
      bx.drawImage(src, 0, 0, bandC.width, bandC.height);
      bx.globalCompositeOperation = 'destination-in';
      const gr = fadeTowards === 'up' ? bx.createLinearGradient(0, bandC.height, 0, 0) : fadeTowards === 'down' ? bx.createLinearGradient(0, 0, 0, bandC.height)
        : fadeTowards === 'left' ? bx.createLinearGradient(bandC.width, 0, 0, 0) : bx.createLinearGradient(0, 0, bandC.width, 0);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      bx.fillStyle = gr; bx.fillRect(0, 0, bandC.width, bandC.height);
      x.drawImage(bandC, x0, y0, w, h);
    };
    const band = (y0, dir, q) => strip(q.map(aFace), XS.bx0, dir < 0 ? y0 - 22 : y0, XS.bx1 - XS.bx0, 22, true, dir < 0 ? 'up' : 'down');
    band(XS.yb, -1, XS.prof.rU);
    band(XS.ybb, 1, XS.prof.rL);
    // package top
    const s = XS.s, o = XS.o;
    if (rad) {
      const Tk = s.Tpkg + 273.15, Tw = s.TwallC + 273.15;   // the package faces the component-side wall
      const qp = 0.818 * 5.670374e-8 * (Tk ** 4 - Tw ** 4), a = aFace(qp);
      const yTop = XS.up ? XS.cy0 : XS.cy0 + XS.ch, dir = XS.up ? -1 : 1;
      const gr = x.createLinearGradient(0, yTop, 0, yTop + dir * 22);
      gr.addColorStop(0, `rgba(255,236,190,${a})`); gr.addColorStop(1, 'rgba(255,236,190,0)');
      x.fillStyle = gr; x.fillRect(XS.cx - XS.cw / 2, Math.min(yTop, yTop + dir * 22), XS.cw, 22);
    }
    // walls: lid and floor along the centre row, side walls along their centre column
    if (rad && rad.enc && rad.lid) {
      const aWall = (G, f) => 1.4 * f.level * Math.pow(G / (f.gmax || 1), 1.6);
      const row = (f) => { const r = (f.nv / 2) | 0; return Array.from({ length: f.nu }, (_, i) => f.G[r * f.nu + i]); };
      const wallStrip = (f, yEdge, dir) => strip(row(f).map(G => aWall(G, f)), XS.bx0, dir > 0 ? yEdge : yEdge - 16, XS.bx1 - XS.bx0, 16, true, dir > 0 ? 'down' : 'up');
      wallStrip(rad.lid, XS.lid, 1);
      wallStrip(rad.floor, XS.floor, -1);
      // side walls at x = ±W/2: map z to the schematic heights (board faces at yb / ybb)
      const zU = o.tb * 1e3 / 2, zLid = zU + o.gapUp * 1e3, zL = -zU, zFl = zL - o.gapDn * 1e3;
      // sample each side wall's centre column at the schematic heights, top to bottom
      for (const f of rad.sides) {
        if (f.axis !== 'x') continue;
        const i = (f.nu / 2) | 0, xEdge = f.sign > 0 ? XS.x1 : XS.x0;
        const n = 120, al = [];
        for (let k = 0; k < n; k++) {
          const y = XS.lid + (k + 0.5) / n * (XS.floor - XS.lid);
          let z;
          if (y <= XS.yb) z = zU + (XS.yb - y) / (XS.yb - XS.lid) * (zLid - zU);
          else if (y >= XS.ybb) z = zL - (y - XS.ybb) / (XS.floor - XS.ybb) * (zL - zFl);
          else { al.push(0); continue; }
          const r = Math.min(f.nv - 1, Math.max(0, Math.floor((zLid - z) / (zLid - zFl) * f.nv)));
          al.push(aWall(f.G[r * f.nu + i], f));
        }
        strip(al, f.sign > 0 ? xEdge - 16 : xEdge, XS.lid, 16, XS.floor - XS.lid, false, f.sign > 0 ? 'left' : 'right');
      }
    }
    xsGlow = c;
    xsParts = [];
    xsStart();
  }
  const XS_PER_W = 55;
  function xsSpawn(dt) {
    if (heatMode === 'rad') return;
    const s = XS.s, f = s.flow, k = XS_PER_W * dt, colW = (XS.bx1 - XS.bx0) / s.nx;
    const emit = (w, fn) => { let n = Math.max(0, w) * k; while (n > 0) { if (Math.random() < n) fn(); n -= 1; } };
    const T01 = T => (T - scale.lo) / (scale.hi - scale.lo);
    emit(f.compConv + f.freeConv - (XS.up ? f.freeConv : f.compConv), () => {             // upper face
      const i = pick1(XS.dU); xsParts.push({ k: 'up', x: XS.bx0 + (i + Math.random()) * colW, y: XS.yb - 2, t: 0, life: 2.6, T: XS.prof.TU[i], ph: Math.random() * 6 });
    });
    emit(XS.up ? f.freeConv : f.compConv, () => {                                         // lower face
      const i = pick1(XS.dL); xsParts.push({ k: 'dn', x: XS.bx0 + (i + Math.random()) * colW, y: XS.ybb + 2, t: 0, life: 2.8, T: XS.prof.TL[i], ph: Math.random() * 6 });
    });
    emit(s.Ptop, () => {
      const y = XS.up ? XS.cy0 - 2 : XS.cy0 + XS.ch + 2;
      xsParts.push({ k: XS.up ? 'up' : 'dn', x: XS.cx + (Math.random() - 0.5) * XS.cw, y, t: 0, life: 2.4, T: s.Tpkg, ph: Math.random() * 6 });
    });
    emit(f.throughArr, () => {                                                             // down (or up) the barrels
      const vx = XS.viaXs[(Math.random() * XS.viaXs.length) | 0];
      xsParts.push({ k: 'via', x: vx, y: XS.up ? XS.yb : XS.ybb, t: 0, life: 0.7, T: scale.hi });
    });
    emit(s.Pboard * 0.6, () => {                                                           // spreading in the copper
      const dir = Math.random() < 0.5 ? -1 : 1;
      xsParts.push({ k: 'sp', x: XS.cx + dir * XS.aw / 2, y: XS.up ? XS.yb + 2 : XS.ybb - 2, dir, t: 0, life: 1.6, T: scale.hi });
    });
    void T01;
  }
  function xsStep(dt) {
    const out = [];
    for (const p of xsParts) {
      p.t += dt;
      if (p.t > p.life) continue;
      if (p.k === 'up') {
        const gap = XS.yb - XS.lid, near = Math.max(0, 1 - (p.y - XS.lid) / (0.25 * gap));
        p.y -= gap / 2.0 * (1 - near) * dt;
        p.x += (Math.sin(p.t * 3 + p.ph) * 8 + near * 40 * Math.sign(p.x - XS.cx || 1)) * dt;
      } else if (p.k === 'dn') {
        const gap = XS.floor - XS.ybb;
        p.y = Math.min(XS.floor - 3, p.y + gap / 6 * dt);
        p.x += (28 * Math.sign(p.x - XS.cx || 1) + Math.sin(p.t * 2 + p.ph) * 4) * dt;
      } else if (p.k === 'via') {
        p.y += (XS.up ? 1 : -1) * XS.tB / 0.7 * dt;
      } else if (p.k === 'sp') {
        p.x += p.dir * 140 * (1 - p.t / p.life) * dt;
      }
      if (p.x < XS.x0 + 2 || p.x > XS.x1 - 2) continue;
      out.push(p);
    }
    xsParts = out;
  }
  function xsDraw() {
    const DPR = Math.min(window.devicePixelRatio || 1, 2), cw = xsCv.clientWidth, ch = xsCv.clientHeight;
    if (!cw) return;
    if (xsCv.width !== Math.round(cw * DPR) || xsCv.height !== Math.round(ch * DPR)) { xsCv.width = Math.round(cw * DPR); xsCv.height = Math.round(ch * DPR); }
    const k = Math.min(cw / 760, ch / 440), ox = (cw - 760 * k) / 2, oy = (ch - 440 * k) / 2;   // same fit as the SVG
    xsCtx.setTransform(1, 0, 0, 1, 0, 0); xsCtx.clearRect(0, 0, xsCv.width, xsCv.height);
    xsCtx.setTransform(DPR * k, 0, 0, DPR * k, DPR * ox, DPR * oy);
    xsCtx.clearRect(0, 0, 760, 440);
    if (xsGlow && heatMode !== 'conv') {
      xsCtx.globalCompositeOperation = 'lighter';
      xsCtx.globalAlpha = (REDUCED ? 1 : 0.86 + 0.14 * Math.sin(1.6 * xsClock)) * (heatMode === 'rad' ? 1 : 0.55);
      xsCtx.drawImage(xsGlow, 0, 0);
      xsCtx.globalAlpha = 1; xsCtx.globalCompositeOperation = 'source-over';
    }
    for (const p of xsParts) {
      const f = p.t / p.life, a = Math.sin(Math.PI * Math.min(1, f * 1.15));
      if (p.k === 'via' || p.k === 'sp') {
        xsCtx.fillStyle = `rgba(255,226,168,${0.9 * a})`;
        xsCtx.beginPath(); xsCtx.arc(p.x, p.y, 1.8, 0, 6.283); xsCtx.fill();
      } else {
        const c = ramp(((p.T - scale.lo) / (scale.hi - scale.lo)) * 0.85 + 0.15);
        xsCtx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${0.75 * a})`;
        xsCtx.beginPath(); xsCtx.arc(p.x, p.y, 2.4 + f * 1.6, 0, 6.283); xsCtx.fill();
      }
    }
  }
  function xsFrame(t) {
    if (!xsRun) return;
    const dt = Math.min(0.05, (t - xsLast) / 1000 || 0.016); xsLast = t; xsClock += dt;
    if (XS && !REDUCED) { xsSpawn(dt); xsStep(dt); }
    xsDraw();
    requestAnimationFrame(xsFrame);
  }
  let xsVisible = true;
  function xsStart() {
    const want = XS && !$('tv-flow').hidden && xsVisible && !document.hidden && !REDUCED;
    if (want && !xsRun) { xsRun = true; xsLast = performance.now(); requestAnimationFrame(xsFrame); }
    else if (!want) { xsRun = false; xsDraw(); }
  }
  if ('IntersectionObserver' in window) new IntersectionObserver(e => { xsVisible = e[0].isIntersecting; xsStart(); }).observe($('tv-flow'));
  document.addEventListener('visibilitychange', xsStart);

  function radTotals() {
    const rad = view3d.radiation();
    if (!rad || !rad.enc || !rad.totals) { $('tv-r-radU').textContent = $('tv-r-radL').textContent = '–'; return; }
    const t = rad.totals;
    $('tv-r-radU').textContent = `${fmtW(t.emitU)} → lid ${fmtW(t.lid)} · sides ${fmtW(t.sidesU)}`;
    $('tv-r-radL').textContent = `${fmtW(t.emitL)} → floor ${fmtW(t.floor)} · sides ${fmtW(t.sidesL)}`;
  }

  // ---- colour scale shared by every view: coldest board point to the hottest
  const ramp = window.TV3D.ramp;
  const rgbs = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a === undefined ? 1 : a})`;
  let scale = { lo: 25, hi: 100 };
  function colourScale(s) {
    let mn = Infinity, mx = -Infinity;
    for (const t of s.Tcomp) { mn = Math.min(mn, t); mx = Math.max(mx, t); }
    for (const t of s.Tfree) { mn = Math.min(mn, t); mx = Math.max(mx, t); }
    scale = { lo: Math.floor(mn), hi: Math.max(mx, Math.floor(mn) + 1) };
    for (const e of document.querySelectorAll('.tv-lg-lo')) e.textContent = scale.lo.toFixed(0) + ' °C';
    for (const e of document.querySelectorAll('.tv-lg-hi')) e.textContent = scale.hi.toFixed(1) + ' °C';
  }
  const tcol = (T, a) => rgbs(ramp((T - scale.lo) / (scale.hi - scale.lo)), a);

  // ---- 3D view
  const view3d = window.TV3D.create($('tv-3d-canvas'));
  let lastSel = null;
  function show3d(s) { lastSel = s; view3d.update(s, scale.lo, scale.hi); }

  // ---- board 2D maps: to scale in a fixed frame, with mm axes
  let mapState = null;
  function maps(s) {
    mapState = { s };
    drawMap($('tv-map-c'), s.Tcomp, s, true);
    drawMap($('tv-map-f'), s.Tfree, s, false);
  }
  function frameOf(cv, s) {
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const cw = cv.clientWidth || 300, hMax = Math.max(160, ($('tv-board').clientHeight || 400) - 60);
    const L = 38, R = 12, T = 10, B = 32;
    const W = s.o.boardW * 1e3, H = s.o.boardH * 1e3;
    const k = Math.min((cw - L - R) / W, (hMax - T - B) / H);    // axes fit the board, aspect kept, within the stage
    const ch = Math.round(T + B + H * k);
    return { DPR, cw, ch, L, T, B, k, W, H, x0: L, y0: T + H * k };
  }
  function drawMap(cv, Tarr, s, comp) {
    const f = frameOf(cv, s), { DPR, cw, ch, k, W, H } = f;
    cv.style.height = ch + 'px';
    cv.width = Math.round(cw * DPR); cv.height = Math.round(ch * DPR);
    const x = cv.getContext('2d');
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
    x.clearRect(0, 0, cw, ch);
    // axes spanning the board exactly, ticks every round step plus the end value
    const step = niceStep(Math.max(W, H) / 5);
    x.font = '400 10px "JetBrains Mono", ui-monospace, monospace'; x.fillStyle = '#9eabc9'; x.lineWidth = 1;
    const ticks = (len) => { const t = []; for (let v = 0; v <= len + 1e-6; v += step) t.push(v); if (len - t[t.length - 1] > step * 0.3) t.push(len); return t; };
    x.strokeStyle = 'rgba(169,192,234,0.5)';
    x.beginPath(); x.moveTo(f.x0, f.y0 - H * k); x.lineTo(f.x0, f.y0); x.lineTo(f.x0 + W * k, f.y0); x.stroke();
    for (const v of ticks(W)) {
      const px = f.x0 + v * k;
      x.beginPath(); x.moveTo(px, f.y0); x.lineTo(px, f.y0 + 4); x.stroke();
      x.textAlign = 'center'; x.textBaseline = 'top'; x.fillText(+v.toFixed(1), px, f.y0 + 6);
    }
    for (const v of ticks(H)) {
      const py = f.y0 - v * k;
      x.beginPath(); x.moveTo(f.x0 - 4, py); x.lineTo(f.x0, py); x.stroke();
      x.textAlign = 'right'; x.textBaseline = 'middle'; x.fillText(+v.toFixed(1), f.x0 - 6, py);
    }
    x.textAlign = 'right'; x.textBaseline = 'top'; x.fillText('x, mm', f.x0 + W * k, f.y0 + 19);
    x.save(); x.translate(4, f.y0 - H * k); x.rotate(-Math.PI / 2); x.textAlign = 'right'; x.textBaseline = 'top'; x.fillText('y, mm', 0, 0); x.restore();
    // heat map
    const { nx, ny } = s;
    const off = document.createElement('canvas'); off.width = nx; off.height = ny;
    const ox = off.getContext('2d'), img = ox.createImageData(nx, ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = j * nx + i, p = ((ny - 1 - j) * nx + i) * 4, col = ramp((Tarr[c] - scale.lo) / (scale.hi - scale.lo));
      img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = 255;
    }
    ox.putImageData(img, 0, 0);
    x.imageSmoothingEnabled = true;
    x.drawImage(off, f.x0, f.y0 - H * k, W * k, H * k);
    x.strokeStyle = 'rgba(232,238,251,0.35)'; x.strokeRect(f.x0, f.y0 - H * k, W * k, H * k);
    // component, array, vias (board coordinates: origin bottom-left, centre W/2, H/2)
    const X = v => f.x0 + v * k, Y = v => f.y0 - v * k;
    const cxm = W / 2, cym = H / 2, o = s.o, mm = 1e3;
    if (comp) {
      const b = Math.max(o.bodyW, o.arrW) * mm;
      x.strokeStyle = 'rgba(232,238,251,0.9)'; x.lineWidth = 1.5;
      x.strokeRect(X(cxm - b / 2), Y(cym + b / 2), b * k, b * k);
    }
    const a = s.arr;
    if (!comp && a && a.d * mm * k > 1.5) {
      const p0x = cxm - (a.m - 1) * a.pitch * mm / 2, p0y = cym - (a.n - 1) * a.pitch * mm / 2;
      x.fillStyle = o.via === 'open' ? 'rgba(5,8,15,0.9)' : 'rgba(232,238,251,0.35)';
      for (let i = 0; i < a.m; i++) for (let j = 0; j < a.n; j++) {
        x.beginPath(); x.arc(X(p0x + i * a.pitch * mm), Y(p0y + j * a.pitch * mm), Math.max(1, a.d * mm * k / 2), 0, 6.283); x.fill();
      }
    }
    x.setLineDash([4, 3]); x.strokeStyle = 'rgba(169,192,234,0.95)'; x.lineWidth = 1.2;
    x.strokeRect(X(cxm - o.arrW * mm / 2), Y(cym + o.arrH * mm / 2), o.arrW * mm * k, o.arrH * mm * k);
    x.setLineDash([]);
    // edge of the copper connected to the array, when it does not cover the board
    const cu = comp ? o.cuComp : o.cuFree;
    if (cu !== 'plane') {
      const e = cu === 'margin' ? o.cuMargin * mm : 0;
      x.strokeStyle = 'rgba(232,170,100,0.95)'; x.lineWidth = 1.5;
      x.strokeRect(X(cxm - o.arrW * mm / 2 - e), Y(cym + o.arrH * mm / 2 + e), (o.arrW * mm + 2 * e) * k, (o.arrH * mm + 2 * e) * k);
    }
    cv.parentElement.querySelector('figcaption').textContent = `${comp ? 'Component side' : 'Free side'} · copper ${cuName(cu, o)}`;
  }
  function readMap(e, comp) {
    if (!mapState) return;
    const cv = e.currentTarget, r = cv.getBoundingClientRect(), s = mapState.s, f = frameOf(cv, s);
    const xm = (e.clientX - r.left - f.x0) / f.k, ym = (f.y0 - (e.clientY - r.top)) / f.k;
    if (xm < 0 || ym < 0 || xm > f.W || ym > f.H) { $('tv-map-read').textContent = 'Point at the board to read the temperature.'; return; }
    const i = Math.min(s.nx - 1, Math.floor(xm / (s.dx * 1e3))), j = Math.min(s.ny - 1, Math.floor(ym / (s.dy * 1e3)));
    const T = (comp ? s.Tcomp : s.Tfree)[j * s.nx + i];
    $('tv-map-read').textContent = `${comp ? 'Component side' : 'Free side'} at x ${xm.toFixed(1)}, y ${ym.toFixed(1)} mm: ${T.toFixed(1)} °C`;
  }
  $('tv-map-c').addEventListener('pointermove', e => readMap(e, true));
  $('tv-map-f').addEventListener('pointermove', e => readMap(e, false));
  new ResizeObserver(() => { if (mapState && !$('tv-board').hidden) maps(mapState.s); }).observe($('tv-board'));

  // ------------------------------------------------------------------- wiring
  for (const r of document.querySelectorAll('input[name="tv-mode"]')) r.addEventListener('change', () => {
    heatMode = document.querySelector('input[name="tv-mode"]:checked').value;
    view3d.setMode(heatMode);
    if (heatMode === 'rad') xsParts = [];
    if (!xsRun) xsDraw();
  });
  function currentView() { return document.querySelector('input[name="tv-view"]:checked').value; }
  for (const r of document.querySelectorAll('input[name="tv-view"]')) r.addEventListener('change', () => {
    const v = currentView();
    $('tv-3d').hidden = v !== '3d'; $('tv-flow').hidden = v !== 'flow'; $('tv-board').hidden = v !== 'board';
    $('tv-legend-heat').style.visibility = v === 'board' ? 'hidden' : '';
    document.querySelector('.tv-keys').style.visibility = v === 'board' ? 'hidden' : '';
    xsStart();
    view3d.setActive(v === '3d');
    if (v === 'board' && mapState) maps(mapState.s);
  });
  for (const e of document.querySelectorAll('.tv-panel input, .tv-panel select')) {
    e.addEventListener('input', () => { labels(); schedule(); });
    e.addEventListener('change', schedule);
  }
  $('tv-reset').addEventListener('click', () => {
    for (const k in defaults) $('i-' + k).value = defaults[k];
    document.querySelector('input[name="i-side"][value="top"]').checked = true;
    $('i-enclosure').checked = true;
    schedule();
  });
  run();
})();
