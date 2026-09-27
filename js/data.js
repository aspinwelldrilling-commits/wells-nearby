/* Wells Nearby — data access + normalization.
 * Works in the browser (window.WellsData) and in Node >= 18 (globalThis.WellsData) for tests.
 */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG;
  const MI_PER_M = 1 / 1609.344;

  function haversineMi(lat1, lon1, lat2, lon2) {
    const R = 3958.7613, toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Parse numbers stored as text ("50", "50+", " 1,200 ", "12.5 gpm"). Returns null if none.
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function inBounds(v, [lo, hi]) { return v != null && v >= lo && v <= hi ? v : null; }

  function parseDate(v) {
    if (v == null || v === '') return null;
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v).length === 10 ? v + 'T00:00:00' : v);
    if (isNaN(d)) return null;
    const y = d.getUTCFullYear();
    if (y < C.bounds.year[0] || y > C.bounds.year[1]) return null;
    return d;
  }

  function classifyMethod(method, fluid) {
    const m = (method || '').toLowerCase().trim(), f = (fluid || '').toLowerCase().trim();
    for (const cat of C.methodCategories) if (cat.test(m, f)) return cat;
    return C.methodCategories[C.methodCategories.length - 1];
  }

  /** Convert a raw record (source-specific field names) to the normalized well object. */
  function normalize(raw, fieldMap, origin) {
    const w = { raw };
    for (const [k, src] of Object.entries(fieldMap)) w[k] = raw[src] ?? null;
    w.lat = num(w.lat); w.lon = num(w.lon);

    w.depthFt = inBounds(num(w.depth), C.bounds.depth);
    w.swlFt = inBounds(num(w.swl), C.bounds.swl);

    const units = (w.yieldUnits || 'GPM').toUpperCase().trim();
    const factor = C.yieldToGpm[units];
    const y = num(w.yield);
    w.yieldRaw = y;
    w.yieldZero = y === 0;
    w.gpm = factor != null ? inBounds(y == null ? null : y * factor, C.bounds.gpm) : null;
    w.yieldUnitUnknown = y != null && factor == null;

    const d = parseDate(w.dateEnded);
    w.dateMs = d ? d.getTime() : null;
    w.year = d ? d.getUTCFullYear() : null;
    w.dateStr = d ? d.toISOString().slice(0, 10) : '—';

    const cat = classifyMethod(w.method, w.fluid);
    w.methodKey = cat.key; w.methodLabel = cat.label; w.methodColor = cat.color;
    w.methodDetail = [w.method, w.fluid && w.fluid !== 'Unknown' ? 'fluid: ' + w.fluid : null].filter(Boolean).join(', ') || 'not recorded';

    w.waterSupply = C.isWaterSupply(w);
    w.destruction = C.isDestruction(w);
    w.useShort = (w.plannedUse || w.b118Use || '').replace(/^Water Supply\s*/i, 'WS ').trim() || '—';

    if (origin && w.lat != null && w.lon != null) w.distanceMi = haversineMi(origin.lat, origin.lon, w.lat, w.lon);
    return w;
  }

  async function fetchJson(url, opts = {}, timeoutMs = 25000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j;
    } finally { clearTimeout(t); }
  }

  /** Primary: ArcGIS spatial query (point + distance), paginated. */
  async function queryArcgis(lat, lon, radiusMi) {
    const S = C.sources.arcgis;
    const outFields = Object.values(S.fieldMap).join(',');
    let offset = 0, all = [], truncated = false;
    while (true) {
      const p = new URLSearchParams({
        where: '1=1',
        geometry: `${lon},${lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        distance: String(radiusMi),
        units: 'esriSRUnit_StatuteMile',
        outFields,
        returnGeometry: 'false',
        orderByFields: 'OBJECTID',
        resultOffset: String(offset),
        resultRecordCount: String(S.pageSize),
        f: 'json',
      });
      const j = await fetchJson(S.queryUrl + '?' + p.toString());
      const feats = (j.features || []).map((f) => f.attributes);
      all = all.concat(feats);
      if (!j.exceededTransferLimit || feats.length === 0) break;
      offset += feats.length;
      if (all.length >= S.maxRecords) { truncated = true; break; }
    }
    return { records: all.map((r) => normalize(r, S.fieldMap, { lat, lon })), source: S.label, truncated };
  }

  /** Fallback: CKAN SQL bounding-box query, then distance filter client-side. */
  async function queryCkan(lat, lon, radiusMi) {
    const S = C.sources.ckan, F = S.fieldMap;
    const dLat = radiusMi / 69.05, dLon = radiusMi / (69.17 * Math.cos(lat * Math.PI / 180));
    const cols = Object.values(F).map((c) => `"${c}"`).join(',');
    const sql = `SELECT ${cols} FROM "${S.resourceId}" WHERE "${F.lat}" BETWEEN ${(lat - dLat).toFixed(6)} AND ${(lat + dLat).toFixed(6)} AND "${F.lon}" BETWEEN ${(lon - dLon).toFixed(6)} AND ${(lon + dLon).toFixed(6)} LIMIT ${S.maxRecords}`;
    const j = await fetchJson(S.sqlUrl + '?sql=' + encodeURIComponent(sql), {}, 40000);
    const rows = j.result.records;
    const recs = rows.map((r) => normalize(r, F, { lat, lon })).filter((w) => w.distanceMi != null && w.distanceMi <= radiusMi);
    return { records: recs, source: S.label, truncated: rows.length >= S.maxRecords };
  }

  async function queryNearby(lat, lon, radiusMi, { prefer = 'arcgis' } = {}) {
    const order = prefer === 'ckan' ? [queryCkan, queryArcgis] : [queryArcgis, queryCkan];
    const errors = [];
    for (const fn of order) {
      try {
        const res = await fn(lat, lon, radiusMi);
        res.records.sort((a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9));
        res.errors = errors;
        return res;
      } catch (e) { errors.push(`${fn.name}: ${e.message || e}`); }
    }
    throw new Error('All data sources failed — ' + errors.join(' | '));
  }

  global.WellsData = { queryNearby, queryArcgis, queryCkan, normalize, haversineMi, classifyMethod, num, MI_PER_M };
})(typeof window !== 'undefined' ? window : globalThis);
