// Runs the via-array model off the main thread: posts the selected case first, then all cases.
importScripts('vias-model.js');
self.onmessage = e => {
  const { id, opts } = e.data;
  try {
    const r = self.ViaModel.compare(opts, partial => self.postMessage({ id, ok: true, r: partial }));
    self.postMessage({ id, ok: true, r });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
