/* Wells Nearby — summary statistics. Add new summaries in summarize(). */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG;

  function numStats(values) {
    const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return { n: 0, min: null, max: null, avg: null, median: null };
    const sum = v.reduce((a, b) => a + b, 0);
    const mid = Math.floor(v.length / 2);
    return { n: v.length, min: v[0], max: v[v.length - 1], avg: sum / v.length,
      median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2 };
  }

  function summarize(wells) {
    const methods = C.methodCategories.map((c) => ({ key: c.key, label: c.label, color: c.color, count: 0, pct: 0 }));
    const byKey = Object.fromEntries(methods.map((m) => [m.key, m]));
    wells.forEach((w) => byKey[w.methodKey].count++);
    methods.forEach((m) => (m.pct = wells.length ? (100 * m.count) / wells.length : 0));
    return {
      total: wells.length,
      depth: numStats(wells.map((w) => w.depthFt)),
      gpm: numStats(wells.map((w) => w.gpm)),
      swl: numStats(wells.map((w) => w.swlFt)),
      year: numStats(wells.map((w) => w.year)),
      yieldZeroCount: wells.filter((w) => w.yieldZero).length,
      yieldUnknownUnits: wells.filter((w) => w.yieldUnitUnknown).length,
      methods,
      accuracy: countBy(wells, (w) => w.llAccuracy || 'Not recorded'),
      uniqueLocations: new Set(wells.map((w) => w.lat + ',' + w.lon)).size,
    };
  }

  function countBy(arr, fn) {
    const m = {};
    arr.forEach((x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }

  global.WellsStats = { summarize, numStats, countBy };
})(typeof window !== 'undefined' ? window : globalThis);
