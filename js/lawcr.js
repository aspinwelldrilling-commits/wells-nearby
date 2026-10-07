/* Wells Nearby — Los Angeles County layer: state DWR OSWCR well completion reports cached in data/la-wcr/
 * (tools/extract_la_wcr.py). LA County has no public well-permit GIS and no county WCR PDFs, so this is state
 * OSWCR only. Its own map overlay ("LA County WCRs"): purple rings for the cached records in view (zoom >= minZoom),
 * loaded per 0.025° tile listed in data/la-wcr/manifest.json, so they also show offline once fetched (service worker).
 * The same records still come back from the live state query; this layer does not feed stats/table (no double count).
 * WCRLinks are DWR Box viewer pages: linked, never downloaded. APN shown as on the record (10-digit AIN as XXXX-XXX-XXX). */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG, D = global.WellsData, A = global.WellsApp;
  const LC = C.laWcr;
  if (!LC || !A || !A.map || typeof L === 'undefined') return;
  const map = A.map;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = LC.manifestUrl.replace(/[^/]*$/, '');
  map.createPane('laWcr'); map.getPane('laWcr').style.zIndex = 450;   // under the state/county pins (markerPane 600)
  const layer = L.layerGroup();
  let manifest = null, manifestP = null;
  const tiles = new Map();   // key -> records (normalized)
  const drawn = new Map();   // point key -> circle marker

  /** 10-digit LA AIN -> XXXX-XXX-XXX; anything else exactly as on the record. */
  function ain(apn) {
    const s = String(apn || '').trim(), d = s.replace(/\D/g, '');
    return d.length === 10 && /^[\d\s-]+$/.test(s) ? `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}` : s;
  }

  function loadManifest() {
    if (!manifestP) manifestP = fetch(LC.manifestUrl, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null))
      .then((m) => (manifest = m && m.tiles ? m : null)).catch(() => null);
    return manifestP;
  }
  async function loadTile(key, t) {
    if (tiles.has(key)) return tiles.get(key);
    try {
      const r = await fetch(`${base}tiles/${key}.json?v=${t.h}`);
      if (!r.ok) return [];
      const j = await r.json();
      const recs = (j.records || []).map((raw) => {
        const w = D.normalize(raw, C.sources.arcgis.fieldMap, null, 'arcgis');
        w.laTile = key;
        const cc = manifest && manifest.coordCountyCheck && manifest.coordCountyCheck.byObjectId[raw.OBJECTID];
        if (cc) w.coordCounty = /^OUTSIDE/.test(cc.county) ? 'no mapped county (harbor / offshore — outside the county land boundaries)'
          : cc.county.replace(/ COUNTY$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) + ' County';
        return w;
      });
      tiles.set(key, recs);
      return recs;
    } catch (e) { return []; }   // offline + never fetched
  }

  function details(w) {
    const row = (k, v) => (v == null || v === '' ? '' : `<tr><th>${k}</th><td>${v}</td></tr>`);
    const loc = [w.address, w.city].filter(Boolean).join(', ');
    const units = w.yieldUnits && !/^gpm$/i.test(w.yieldUnits) ? ' ' + esc(w.yieldUnits) : ' GPM';
    return `<div class="la-item"><h3>${esc(w.wcr || w.legacyLog || 'WCR')}</h3><table class="kv">
      ${row('Location', esc(loc) || '<span class="muted">not on record</span>')}
      ${row('APN', w.apn ? esc(ain(w.apn)) : '')}
      ${row('Permit', esc(w.permit || ''))}
      ${row('Depth', w.depthFt != null ? Math.round(w.depthFt) + ' ft' : '—')}
      ${row('Yield', w.yieldRaw != null ? esc(w.yieldRaw) + units : '—')}
      ${row('SWL', w.swlFt != null ? Math.round(w.swlFt) + ' ft' : '—')}
      ${row('Method', esc(w.methodDetail))}
      ${row('Ended', esc(w.dateStr))}
      ${row('Use', esc(w.plannedUse || w.b118Use || ''))}
      ${row('Type', esc(w.recordType || ''))}
      ${row('Driller', esc(w.driller || ''))}
      ${w.raw && w.raw._laOverride ? row('Note', esc(w.raw._laOverride)) : ''}
      ${w.coordCounty ? row('Note', `DWR lists this WCR in Los Angeles County, but its coordinates fall in ${esc(w.coordCounty)}`) : ''}
      ${row('Lat/lon', `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}${w.llAccuracy ? ' · ' + esc(w.llAccuracy) : ''}`)}
      </table>${w.pdfUrl ? `<a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">📄 Open WCR (DWR Box viewer)</a>` : '<span class="muted">No WCR link on the state record</span>'}</div>`;
  }

  function popup(ws) {
    const sorted = [...ws].sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
    const shown = sorted.slice(0, 25);
    const box = document.createElement('div'); box.className = 'popup la-popup';
    box.innerHTML = `<div class="srcTag" style="background:${LC.color};color:#fff">${esc(LC.label)}</div>
      ${ws.length > 1 ? `<h3>${ws.length} records at this point</h3>` : ''}${shown.map(details).join('<hr>')}
      ${ws.length > shown.length ? `<div class="muted">+${ws.length - shown.length} more — search here for the full table</div>` : ''}
      <button type="button" class="small search-here">Search here</button>`;
    const b = box.querySelector('.search-here');
    L.DomEvent.on(b, 'click', (ev) => { L.DomEvent.stop(ev); map.closePopup(); A.setLocation(ws[0].lat, ws[0].lon, 'LA WCR pin'); });
    return box;
  }

  let drawId = 0;
  async function draw() {
    const id = ++drawId;
    if (!map.hasLayer(layer)) return;
    await loadManifest();
    if (!manifest || id !== drawId) return;
    if (map.getZoom() < LC.minZoom) { layer.clearLayers(); drawn.clear(); return; }
    const vb = map.getBounds().pad(0.1);
    const keys = Object.entries(manifest.tiles).filter(([, t]) => vb.intersects(L.latLngBounds([t.b[0], t.b[1]], [t.b[2], t.b[3]])));
    const lists = await Promise.all(keys.map(([k, t]) => loadTile(k, t)));
    if (id !== drawId) return;
    const groups = new Map();
    for (const w of lists.flat()) {
      if (w.lat == null || !vb.contains([w.lat, w.lon])) continue;
      const k = w.lat.toFixed(5) + ',' + w.lon.toFixed(5);
      (groups.get(k) || groups.set(k, []).get(k)).push(w);
    }
    // Diff against what is drawn (a full redraw would close an open popup when the map auto-pans to show it).
    const keep = new Set([...groups.keys()].slice(0, LC.maxPoints));
    for (const [k, m] of drawn) if (!keep.has(k) || m._laN !== groups.get(k).length) { layer.removeLayer(m); drawn.delete(k); }
    for (const k of keep) {
      if (drawn.has(k)) continue;
      const ws = groups.get(k);
      const m = L.circleMarker([ws[0].lat, ws[0].lon], { pane: 'laWcr', radius: ws.length > 1 ? Math.min(12, 6 + Math.log2(ws.length) * 1.5) : 6,
        bubblingMouseEvents: false, color: LC.color, weight: 2.5, fillColor: LC.color, fillOpacity: 0.15 })
        .bindPopup(() => popup(ws), { maxWidth: 320, maxHeight: 340 }).addTo(layer);
      m._laN = ws.length; drawn.set(k, m);
    }
  }

  if (A.layersCtl) A.layersCtl.addOverlay(layer, `<span class="lg" style="border-radius:50%;border:2.5px solid ${LC.color};background:transparent"></span> LA County WCRs (DWR, cached)`);
  map.on('moveend zoomend overlayadd', (e) => { if (!e || e.type !== 'overlayadd' || e.layer === layer) draw(); });
  layer.addTo(map);
  draw();

  global.WellsLaWcr = { draw, ain, loadManifest, get manifest() { return manifest; }, get loadedTiles() { return [...tiles.keys()]; },
    get drawn() { return layer.getLayers().length; } };
})(typeof window !== 'undefined' ? window : globalThis);
