/* Wells Nearby — Imperial County well completion reports (DWR OSWCR snapshot) as their own map overlay.
 * Data: data/imperial-wcr/manifest.json + tiles/<iy>_<ix>.json (0.025° grid, same as data/riverside-wcr), built by
 * tools/build_imperial_wcr.py from the DWR OSWCR index (CountyName = Imperial). Only values from the DWR index are shown.
 * Most Imperial WCRs are placed at the centre of their PLSS section, so the popup always shows DWR's location accuracy.
 * The live State search already returns these same WCRs, so this overlay is NOT merged into the search table / stats.
 */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG, A = global.WellsApp;
  const cfg = C && C.imperialWcr;
  if (!A || !A.map || !cfg || typeof L === 'undefined') return;
  const map = A.map;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const st = document.createElement('style');
  st.textContent = `.lg-imperial{border-radius:50%;background:${cfg.color};border:2px solid #fff;box-shadow:0 0 0 1px #999}
.imp-warn{color:#b45309;font-size:12px;margin:2px 0}.imp-oc{color:#b91c1c;font-size:12px;margin:2px 0}
.popup .imp-tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:#fae8ff;color:#86198f;margin-bottom:4px}`;
  document.head.appendChild(st);

  map.createPane('imperialWcr').style.zIndex = 450;   // above tiles/overlays, below the search pins (markerPane 600)
  const layer = L.layerGroup();
  if (A.layersCtl) A.layersCtl.addOverlay(layer, `<span class="lg lg-imperial"></span> ${esc(cfg.label)}`);
  if (cfg.defaultOn) layer.addTo(map);

  let manifestP = null, manifest = null;
  const loaded = new Map();   // tile key -> hash
  const records = {};         // wcr -> record

  function loadManifest() {
    if (!manifestP) {
      manifestP = fetch(cfg.manifestUrl, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null))
        .then((m) => { manifest = m && m.tiles ? m : null; return manifest; }).catch(() => null);
    }
    return manifestP;
  }

  const approxOf = (r) => !r.acc || /centroid/i.test(r.acc) || /TRS/i.test(r.llm || '') || /^>/.test(r.acc);

  function accHtml(r) {
    let s = `${esc(r.acc || 'not recorded')}${r.llm ? ` (${esc(r.llm)})` : ''}`;
    let warn = '';
    if (/centroid/i.test(r.acc || '')) warn = '⚠ Approximate: DWR placed this pin at the centre of the PLSS section (≈1 sq mi); the well may be up to ~0.7 mi away.';
    else if (!r.acc) warn = '⚠ DWR recorded no location accuracy — treat the pin as approximate.';
    else if (/^>/.test(r.acc)) warn = '⚠ DWR location accuracy is worse than 50 ft.';
    return { s, warn };
  }

  function row(k, v) { return v == null || v === '' ? '' : `<tr><td>${k}</td><td>${v}</td></tr>`; }

  function detailHtml(r) {
    const a = accHtml(r);
    const pdf = /^https:\/\//i.test(r.pdf || '')
      ? `<a href="${esc(r.pdf)}" target="_blank" rel="noopener">📄 WCR PDF (DWR Box viewer)</a>`
      : '<span class="muted">No PDF link in the DWR index</span>';
    const depth = [r.cd != null ? `${esc(r.cd)} ft completed` : '', r.dd != null ? `${esc(r.dd)} ft drilled` : ''].filter(Boolean).join(', ');
    const yld = r.y != null ? `${esc(r.y)} ${esc(r.yu || '')}`.trim() : '';
    const meth = [r.m, r.fl ? 'fluid: ' + r.fl : ''].filter(Boolean).map(esc).join(', ');
    const perf = r.pt != null || r.pb != null ? `${esc(r.pt ?? '?')}–${esc(r.pb ?? '?')} ft` : '';
    const drl = r.drl ? esc(r.drl) + (r.lic ? ` (lic ${esc(r.lic)})` : '') : '';
    const loc = [r.loc, r.city].filter(Boolean).map(esc).join(', ');
    const pmt = [r.pmt, r.pdt, r.lpa].filter(Boolean).map(esc).join(' · ');
    const trs = r.twp || r.rng || r.sec ? `T${esc(r.twp || '?')} R${esc(r.rng || '?')} Sec ${esc(r.sec || '?')}${r.bm ? ' ' + esc(r.bm) : ''}` : '';
    return `<h3>${esc(r.wcr)}</h3>
      <table>
        ${row('Record', esc(r.rt))}${row('Use', esc(r.use || r.b118))}${row('Work ended', esc(r.end))}
        ${row('Depth', depth)}${row('SWL', r.swl != null ? esc(r.swl) + ' ft' : '')}${row('Yield', yld)}${row('Method', meth)}
        ${row('Casing', r.csg != null ? esc(r.csg) + ' in' : '')}${row('Perforated', perf)}${row('Driller', drl)}
        ${row('Location', loc)}${row('APN', esc(r.apn))}${row('Permit', pmt)}${row('Legacy log', esc(r.leg))}${row('TRS', trs)}
        ${row('Lat / Lon', `${(+r.lat).toFixed(5)}, ${(+r.lon).toFixed(5)}`)}${row('Accuracy', a.s)}
      </table>
      ${a.warn ? `<div class="imp-warn">${a.warn}</div>` : ''}
      ${r.oc ? '<div class="imp-oc">⚠ DWR coordinates fall outside the Imperial County line.</div>' : ''}
      <div>${pdf}</div>`;
  }

  function popupFor(stack) {
    const box = document.createElement('div'); box.className = 'popup';
    const n = stack.length;
    const head = `<span class="imp-tag">Imperial · DWR WCR snapshot</span>${n > 1 ? `<div><b>${n} WCRs at this point</b> (DWR often stacks every WCR in a section on its centre)</div>` : ''}`;
    const body = n > 1 ? `<div class="list">${stack.map((r) => `<div class="item">${detailHtml(r)}</div>`).join('')}</div>` : detailHtml(stack[0]);
    box.innerHTML = `${head}${body}<div style="margin-top:4px"><button type="button" class="small">Search wells here</button></div>`;
    const b = box.querySelector('button');
    L.DomEvent.on(b, 'click', (ev) => { L.DomEvent.stop(ev); map.closePopup(); A.setLocation(+stack[0].lat, +stack[0].lon, 'Imperial WCR ' + stack[0].wcr); });
    return box;
  }

  function drawTile(t) {
    const stacks = new Map();
    for (const r of Object.values(t.wcrs || {})) {
      records[r.wcr] = r;
      const k = `${r.lat},${r.lon}`;
      if (!stacks.has(k)) stacks.set(k, []);
      stacks.get(k).push(r);
    }
    for (const stack of stacks.values()) {
      stack.sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')));
      const approx = stack.every(approxOf);
      L.circleMarker([+stack[0].lat, +stack[0].lon], {
        pane: 'imperialWcr', bubblingMouseEvents: false, radius: stack.length > 1 ? 8 : 6, color: cfg.color, weight: 2,
        dashArray: approx ? '3 3' : null, fillColor: cfg.color, fillOpacity: approx ? 0.2 : 0.85,
      }).bindPopup(() => popupFor(stack), { maxWidth: 310, maxHeight: 320 })
        .bindTooltip(stack.length > 1 ? `${stack.length} Imperial WCRs` : esc(stack[0].wcr), { direction: 'top' })
        .addTo(layer);
    }
  }

  let busy = false;
  async function refresh() {
    if (busy || !map.hasLayer(layer) || map.getZoom() < (cfg.minZoom || 0)) return;
    busy = true;
    try {
      const m = await loadManifest();
      if (!m) return;
      const b = map.getBounds().pad(0.2);
      const need = Object.entries(m.tiles).filter(([k, t]) => loaded.get(k) !== t.h
        && t.b[0] <= b.getNorth() && t.b[2] >= b.getSouth() && t.b[1] <= b.getEast() && t.b[3] >= b.getWest());
      const base = cfg.manifestUrl.replace(/[^/]*$/, '');
      for (let i = 0; i < need.length; i += 6) {   // a few tiles at a time
        await Promise.all(need.slice(i, i + 6).map(async ([k, t]) => {
          try {
            const r = await fetch(`${base}tiles/${k}.json?v=${t.h}`);
            if (!r.ok) return;
            const j = await r.json();
            if (loaded.has(k)) return;   // already drawn (hashes only change on a new deploy; reload picks those up)
            loaded.set(k, t.h); drawTile(j);
          } catch (e) { /* offline and not cached */ }
        }));
      }
    } finally { busy = false; }
  }

  map.on('moveend overlayadd', refresh);
  refresh();
  global.WellsImperial = { layer, refresh, loadManifest, records, loaded, detailHtml };
})(typeof window !== 'undefined' ? window : globalThis);
