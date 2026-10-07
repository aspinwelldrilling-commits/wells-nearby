/* Wells Nearby — merge values read from San Diego County completion reports (tools/extract_county_wcr.py,
 * cached in data/county-wcr/index.json) into county permits and their matched state WCRs, and decide which
 * wells Travis has to read himself.
 *
 * Per well, w.wcrFlag:
 *   'state'   depth available from the state WCR database
 *   'ocr'     depth taken from the county WCR (OCR / text layer)
 *   'read'    county permit processed but no usable depth: handwritten/unreadable/no WCR found  -> RED
 *   'pending' county permit not processed yet (no cached result) and no depth from the state  -> neutral
 *   'destroyed' the county WCR is a destruction report
 *   ''        state-only well with no county permit link
 */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG, D = global.WellsData;
  // Data is sharded on a fixed lat/lon grid (tools/extract_county_wcr.py): data/county-wcr/manifest.json lists each tile's
  // bounds + content hash; only tiles intersecting the search circle are fetched (tiles/<key>.json?v=<hash>, so a changed
  // tile gets a new URL). The service worker keeps fetched tiles for offline use. Falls back to the old single index.json
  // if there is no manifest.
  let INDEX = null, manifestP = null;
  // One entry per cache: { key, base, manifest, loaded: Map(tileKey -> hash) }
  const CACHES = [];
  const cacheList = () => {
    const list = (C.countyWcr && C.countyWcr.caches) || null;
    if (list && list.length) return list;
    return [{ key: 'sandiego', manifestUrl: C.countyWcr.manifestUrl, indexUrl: C.countyWcr.indexUrl }];
  };

  async function load() {
    if (manifestP) return manifestP;
    manifestP = (async () => {
      INDEX = INDEX || {};
      CACHES.length = 0;
      for (const cfg of cacheList()) {
        const entry = { key: cfg.key || cfg.manifestUrl, base: cfg.manifestUrl.replace(/[^/]*$/, ''), manifest: null, loaded: new Map() };
        try {
          const r = await fetch(cfg.manifestUrl, { cache: 'no-cache' });
          if (r.ok) { const m = await r.json(); if (m && m.tiles) entry.manifest = m; }
        } catch (e) { /* offline / not published yet */ }
        if (!entry.manifest && cfg.indexUrl) {
          try {
            const r = await fetch(cfg.indexUrl, { cache: 'no-cache' });
            if (r.ok) Object.assign(INDEX, (await r.json()).permits || {});
          } catch (e) { /* none */ }
          entry.manifest = { legacy: true, tiles: {} };
        }
        if (entry.manifest) CACHES.push(entry);
      }
      return INDEX;
    })();
    return manifestP;
  }

  /** Tiles across every cache intersecting the circle (lat, lon, radiusMi). */
  function tilesFor(lat, lon, radiusMi) {
    const dLat = radiusMi / 69.05 + 0.001, dLon = radiusMi / (69.17 * Math.cos(lat * Math.PI / 180)) + 0.001;
    const out = [];
    for (const c of CACHES) {
      if (!c.manifest || !c.manifest.tiles) continue;
      for (const [k, t] of Object.entries(c.manifest.tiles)) {
        if (t.b[0] <= lat + dLat && t.b[2] >= lat - dLat && t.b[1] <= lon + dLon && t.b[3] >= lon - dLon) {
          out.push({ cache: c, key: k, tile: t });
        }
      }
    }
    return out;
  }

  /** Make sure the WCR results for every county permit within radiusMi of (lat, lon) are loaded. */
  async function ensure(lat, lon, radiusMi) {
    await load();
    const need = tilesFor(lat, lon, radiusMi).filter(({ cache, key, tile }) => cache.loaded.get(key) !== tile.h);
    await Promise.all(need.map(async ({ cache, key, tile }) => {
      try {
        const r = await fetch(`${cache.base}tiles/${key}.json?v=${tile.h}`);
        if (!r.ok) return;
        const j = await r.json();
        Object.assign(INDEX, j.permits || {}); cache.loaded.set(key, tile.h);
      } catch (e) { /* offline and not cached: those permits show as not processed */ }
    }));
    return INDEX;
  }

  /** County permit record for a well permit that is only in the DEH document library (opened after the county GIS
   *  permit layer ends in Aug 2020). Located at the parcel centre, like layer permits. */
  function libRecord(permit, lat, lon, apn, firstDoc, origin) {
    const F = C.sources.county.fieldMap, raw = {};
    raw[F.permit] = permit; raw[F.apn] = apn || ''; raw[F.lat] = lat; raw[F.lon] = lon;
    raw[F.dateEnded] = firstDoc ? Date.parse(firstDoc) : null; raw[F.recordType] = 'Well permit (DEH library only)';
    raw[F.status] = 'Not in county GIS layer (after Aug 2020)'; raw[F.wellUse] = '';
    const w = D.normalize(raw, F, origin, 'county');
    w.libraryOnly = true; w.llAccuracy = 'Parcel center (APN, assessor parcel)';
    return w;
  }
  /** Library-only permits cached in the loaded tiles within radiusMi (skipping permits already in `known`). */
  function libraryRecords(lat, lon, radiusMi, known) {
    const out = [];
    for (const [p, e] of Object.entries(INDEX || {})) {
      if (!e.lib || known.has(p)) continue;
      if (D.haversineMi(lat, lon, e.lib.lat, e.lib.lon) > radiusMi) continue;
      out.push(libRecord(p, e.lib.lat, e.lib.lon, e.lib.apn, e.lib.firstDoc, { lat, lon }));
    }
    return out;
  }

  const usable = (f) => f && (f.conf === 'high' || f.conf === 'medium');
  const inB = (v, [lo, hi]) => v != null && v >= lo && v <= hi;

  /** Usable OCR values for a permit entry, after plausibility checks. */
  function ocrValues(entry) {
    // Only records classified 'readable' (depth + another key field legible -> typed form) feed the stats/table.
    // 'partial' records are mostly handwriting where tesseract picks up stray digits; they stay red, with hints.
    if (!entry || entry.status !== 'readable') return {};
    const f = entry.fields || {}, B = C.bounds, out = {};
    if (usable(f.depthFt) && inB(f.depthFt.value, B.depth)) out.depthFt = f.depthFt;
    if (usable(f.gpm) && inB(f.gpm.value, B.gpm)) out.gpm = f.gpm;
    if (usable(f.swlFt) && inB(f.swlFt.value, B.swl)) out.swlFt = f.swlFt;
    if (usable(f.method)) out.method = f.method;
    if (f.fluid && usable(f.fluid)) out.fluid = f.fluid;
    if (usable(f.dateEnded)) { const y = +f.dateEnded.value.slice(0, 4); if (inB(y, B.year)) out.dateEnded = f.dateEnded; }
    if (f.gps && usable(f.gps)) out.gps = f.gps;
    return out;
  }

  // Fill missing values on record w from OCR values v; note source per field; compare with existing state values.
  function fill(w, v, entry) {
    w.fieldSrc = w.fieldSrc || {};
    w.ocrCheck = [];
    const T = C.countyWcr.agreeTolerance;
    for (const k of ['depthFt', 'gpm', 'swlFt']) {
      if (!v[k]) continue;
      if (w[k] == null) { w[k] = v[k].value; w.fieldSrc[k] = { src: 'ocr', conf: v[k].conf }; }
      else if (w.fieldSrc[k] == null || w.fieldSrc[k].src !== 'ocr') {
        const ok = Math.abs(w[k] - v[k].value) <= Math.max(T.abs[k], T.rel * w[k]);
        w.ocrCheck.push({ field: k, state: w[k], ocr: v[k].value, ok });
      }
    }
    if (v.method && (w.methodKey === 'nolog' || w.methodKey === 'other') && !w.method) {
      const cat = D.classifyMethod(v.method.value, v.fluid ? v.fluid.value : '');
      if (cat.key !== 'other' || w.methodKey === 'nolog') {
        w.methodKey = cat.key; w.methodLabel = cat.label; w.methodColor = cat.color;
        w.methodDetail = v.method.value + (v.fluid ? ', fluid: ' + v.fluid.value : '') + ' (county WCR, OCR)';
        w.fieldSrc.method = { src: 'ocr', conf: v.method.conf };
      }
    }
    if (v.dateEnded && (w.group === 'county' ? !w.fieldSrc.date : w.dateMs == null)) {
      if (w.group === 'county' && !w.openedStr) w.openedStr = w.dateStr;
      const d = new Date(v.dateEnded.value + 'T00:00:00Z');
      w.dateMs = d.getTime(); w.year = d.getUTCFullYear(); w.dateStr = v.dateEnded.value; w.fieldSrc.date = { src: 'ocr', conf: v.dateEnded.conf };
    }
  }

  function flagFor(w, entry, hasCounty) {
    if (w.depthFt != null) return w.fieldSrc && w.fieldSrc.depthFt && w.fieldSrc.depthFt.src === 'ocr' ? 'ocr' : 'state';
    if (!hasCounty) return '';
    if (!entry) return 'pending';
    if (entry.status === 'destruction_wcr') return 'destroyed';
    return 'read';
  }

  const LABEL = { state: 'State', ocr: 'County OCR', read: 'READ ↗', pending: 'Pending', destroyed: 'Destroyed', '': '' };

  /** Apply the cached county WCR values. origin = {lat, lon} of the search (to recompute distance when GPS is used). */
  function apply(stateRecs, countyRecs, origin) {
    const idx = INDEX || {};
    for (const c of countyRecs) {
      const entry = idx[c.permit] || null;
      c.wcrEntry = entry; c.wcrStatus = entry ? entry.status : 'not_processed';
      c.wcrDocUrl = (entry && entry.bestDocUrl) || c.countyWcrUrl || c.pdfUrl || null;
      const v = ocrValues(entry);
      c.ocrValues = v;
      fill(c, v, entry);
      // Precise GPS written on the county WCR (only if near the parcel center, to reject misreads).
      if (v.gps && !c.gpsApplied && c.lat != null) {
        const d = D.haversineMi(c.lat, c.lon, v.gps.lat, v.gps.lon);
        if (d <= C.countyWcr.maxGpsShiftMiles) {
          c.parcelPoint = [c.lat, c.lon]; c.lat = v.gps.lat; c.lon = v.gps.lon; c.gpsApplied = true;
          c.llAccuracy = 'GPS on county WCR (OCR)';
          if (origin) c.distanceMi = D.haversineMi(origin.lat, origin.lon, c.lat, c.lon);
        }
      }
      c.wcrFlag = flagFor(c, entry, true); c.wcrLabel = LABEL[c.wcrFlag];
    }
    for (const s of stateRecs) {
      const c = s.match && s.match.county;
      if (c) { s.wcrEntry = c.wcrEntry; s.wcrStatus = c.wcrStatus; s.wcrDocUrl = c.wcrDocUrl; fill(s, c.ocrValues || {}, c.wcrEntry); }
      s.wcrFlag = flagFor(s, c ? c.wcrEntry : null, !!c); s.wcrLabel = LABEL[s.wcrFlag];
      if (c && s.wcrFlag === 'state' && c.wcrFlag !== 'ocr') { c.wcrFlag = 'state'; c.wcrLabel = LABEL.state; }
    }
  }

  /** Unverified values from a partly legible report, shown as hints in the red popup (never used in stats). */
  function hints(entry) {
    if (!entry || entry.status !== 'partial') return [];
    const f = entry.fields || {}, out = [];
    const n = (k, lab, unit) => { if (f[k] && f[k].conf !== 'low') out.push(`${lab} ${f[k].value}${unit}?`); };
    n('depthFt', 'depth', ' ft'); n('gpm', 'yield', ' GPM'); n('swlFt', 'SWL', ' ft');
    if (f.method && f.method.conf !== 'low') out.push(`method ${f.method.value}?`);
    if (f.dateEnded && f.dateEnded.conf !== 'low') out.push(`ended ${f.dateEnded.value}?`);
    return out;
  }

  const STATUS_TEXT = {
    readable: 'Values read from the county completion report',
    partial: 'Only some values could be read from the county completion report',
    unreadable: 'County completion report found but not machine-readable (handwritten or poor scan)',
    no_wcr: 'No completion report found among the county documents (permit papers only)',
    no_docs: 'No documents for this permit in the county library',
    destruction_wcr: 'County report is a well destruction report',
    error: 'County library lookup failed during processing',
    not_processed: 'Not yet processed (this area has not been run through the extractor)',
  };

  global.WellsCountyWcr = { load, ensure, libRecord, libraryRecords, tilesFor, apply, ocrValues, hints, STATUS_TEXT, get index() { return INDEX; }, get manifest() { return (CACHES[0] || {}).manifest || null; }, get caches() { return CACHES; }, get loadedTiles() { return CACHES.flatMap((c) => [...c.loaded.keys()]); } };
})(typeof window !== 'undefined' ? window : globalThis);
