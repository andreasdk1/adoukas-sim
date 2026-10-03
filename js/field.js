// Hero background: particles advected along the 2D magnetostatic field of a few
// slowly drifting line currents (Biot–Savart, B ∝ I·ẑ×r̂ / r). Trails fade so the
// particles paint field lines. Pauses off-screen; static frame for reduced motion.
(function () {
  const canvas = document.getElementById('field');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const marks = document.getElementById('field-marks');
  const mctx = marks.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const BG = [8, 14, 30];            // must match --hero-bg
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0, H = 0, particles = [], running = false, raf = 0, t = 0;

  // Conductors: position as fraction of the canvas, current sign/magnitude,
  // and a small Lissajous drift so the pattern keeps evolving.
  const sources = [
    { fx: 0.62, fy: 0.34, I:  1.0, ax: 0.020, ay: 0.030, p: 0.0 },
    { fx: 0.78, fy: 0.56, I: -1.2, ax: 0.025, ay: 0.020, p: 1.7 },
    { fx: 0.58, fy: 0.74, I:  0.8, ax: 0.018, ay: 0.024, p: 3.1 },
    { fx: 0.90, fy: 0.24, I: -0.7, ax: 0.015, ay: 0.020, p: 4.4 },
    { fx: 0.70, fy: 0.88, I: -0.5, ax: 0.012, ay: 0.020, p: 2.2 },
  ];
  let S = [];

  function place() {
    const narrow = W < 760;
    S = sources.map(s => {
      const fx = narrow ? 0.15 + s.fx * 0.8 : s.fx;
      return {
        x: (fx + s.ax * Math.sin(t * 0.00021 + s.p)) * W,
        y: (s.fy + s.ay * Math.cos(t * 0.00017 + s.p * 1.3)) * H,
        I: s.I,
      };
    });
  }

  function field(x, y) {
    let bx = 0.12, by = 0.0;        // weak uniform background field
    for (const s of S) {
      const dx = x - s.x, dy = y - s.y;
      const r2 = dx * dx + dy * dy + 40;
      const k = s.I * 900 / r2;
      bx += -dy * k / 30;
      by +=  dx * k / 30;
    }
    return [bx, by];
  }

  function spawn(p) {
    p.x = Math.random() * W;
    p.y = Math.random() * H;
    p.life = 60 + Math.random() * 180;
    return p;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    for (const c of [canvas, marks]) {
      c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
      c.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    ctx.fillStyle = `rgb(${BG})`;
    ctx.fillRect(0, 0, W, H);
    const n = Math.min(1800, Math.round(W * H / 520));
    particles = Array.from({ length: n }, () => spawn({}));
    place();
  }

  // |B| -> colour: deep blue -> logo blue -> pale ice
  function colour(m) {
    const u = Math.min(1, Math.log1p(m * 2.2) / 2.4);
    const r = 40 + u * 170, g = 70 + u * 160, b = 140 + u * 115;
    return `rgba(${r | 0},${g | 0},${b | 0},${0.5 + u * 0.5})`;
  }

  function step() {
    ctx.fillStyle = `rgba(${BG},0.055)`;
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1.1;
    for (const p of particles) {
      const [bx, by] = field(p.x, p.y);
      const m = Math.hypot(bx, by) || 1e-6;
      const sp = 1.1;
      const nx = p.x + (bx / m) * sp, ny = p.y + (by / m) * sp;
      ctx.strokeStyle = colour(m);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
      p.x = nx; p.y = ny;
      let near = false;
      for (const s of S) if ((p.x - s.x) ** 2 + (p.y - s.y) ** 2 < 120) near = true;
      if (--p.life < 0 || near || p.x < -10 || p.y < -10 || p.x > W + 10 || p.y > H + 10) spawn(p);
    }
  }

  // Conductor markers: ⊙ current out of page, ⊗ into page
  function drawMarks() {
    mctx.clearRect(0, 0, W, H);
    mctx.strokeStyle = 'rgba(200,215,245,0.75)';
    mctx.fillStyle = `rgb(${BG})`;
    mctx.lineWidth = 1.1;
    for (const s of S) {
      mctx.beginPath(); mctx.arc(s.x, s.y, 7, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
      mctx.beginPath();
      if (s.I > 0) { mctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2); mctx.fillStyle = 'rgba(200,215,245,0.9)'; mctx.fill(); mctx.fillStyle = `rgb(${BG})`; }
      else { mctx.moveTo(s.x - 3.5, s.y - 3.5); mctx.lineTo(s.x + 3.5, s.y + 3.5); mctx.moveTo(s.x + 3.5, s.y - 3.5); mctx.lineTo(s.x - 3.5, s.y + 3.5); mctx.stroke(); }
    }
  }

  function frame(now) {
    t = now;
    place();
    step(); step();
    drawMarks();
    if (running) raf = requestAnimationFrame(frame);
  }

  function start() { if (!running && !reduced) { running = true; raf = requestAnimationFrame(frame); } }
  function stop() { running = false; cancelAnimationFrame(raf); }

  resize();
  if (reduced) {
    for (let i = 0; i < 260; i++) step();
    drawMarks();
  } else {
    // Pre-warm so the first paint already shows field lines
    for (let i = 0; i < 90; i++) step();
    new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop())).observe(canvas);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  }
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { resize(); if (reduced) { for (let i = 0; i < 260; i++) step(); drawMarks(); } }, 150);
  });
})();
