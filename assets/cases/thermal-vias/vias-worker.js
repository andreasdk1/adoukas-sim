// Runs the via-array model off the main thread: posts the selected case first, then all
// cases, then the junction temperature for each drill, one drill per task so that a newer
// request is picked up between them. Keeps the last solution to start the next request from.
importScripts('vias-model.js');
const cache = {};
let latest = 0;
self.onmessage = e => {
  const { id, opts } = e.data;
  latest = id;
  try {
    const r = self.ViaModel.compare(opts, partial => self.postMessage({ id, ok: true, r: partial }), cache);
    self.postMessage({ id, ok: true, r });
    if (!r.opt.best) return;
    const next = self.ViaModel.drillSweep(opts, { state: cache.state });
    const rows = [];
    const tick = () => {
      if (id !== latest) return;                    // superseded
      const row = next();
      if (row) rows.push(row);
      if (!row || rows.length === row.of) { self.postMessage({ id, ok: true, drills: rows }); return; }
      if (rows.length % 4 === 0) self.postMessage({ id, ok: true, drills: rows.slice(), partial: true });
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  } catch (err) {
    cache.state = null;
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
