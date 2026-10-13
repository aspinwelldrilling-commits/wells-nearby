/* Wells Nearby — San Diego County state well completion reports (DWR OSWCR snapshot) as map overlays.
 * Data: data/sd-oswcr/manifest.json + tiles/<iy>_<ix>.json (0.025° grid), built by tools/build_sd_oswcr.py from the DWR
 * OSWCR index (CountyName = San Diego). The County DEHQ permit layer stops ~2020, so these fill 2020 -> today plus every older
 * state report that has no County permit. Reports matched to a County permit are NOT drawn again; their WCR link is in
 * data/sd-oswcr/matched.json and is shown in that County permit's popup (WellsSdOswcr.matchedFor).
 * Two overlays: water-supply wells + destructions (on), monitoring & other non-water uses (off).
 * The live State search already returns these same WCRs, so the overlays do not feed the search table / stats.
 */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG, A = global.WellsApp;
  const cfg = C && C.sdOswcr;
  if (!A || !A.map || !cfg || typeof L === 'undefined') return;
  const map = A.map;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const st = document.createElement('style');
  st.textContent = `.lg-sdo{border-radius:50%;background:${cfg.color};border:2px solid #fff;box-shadow:0 0 0 1px #999}
.lg-sdo-d{border-radius:50%;background:${cfg.color};border:3px solid ${cfg.destroyRing};box-sizing:border-box}
.lg-sdo-m{border-radius:50%;background:transparent;border:2px solid ${cfg.otherColor}}
.sdo-warn{color:#b45309;font-size:12px;margin:2px 0}
.popup .sdo-tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:#ecfccb;color:#3f6212;margin-bottom:4px}
.popup .sdo-tag.d{background:#1f2937;color:#fff}.popup .sdo-tag.m{background:#e2e8f0;color:#334155}
.sdo-link{font-size:12px;margin:3px 0}`;
  document.head.appendChild(st);

  map.createPane('sdOswcr').style.zIndex = 450;   // under the search pins (markerPane 600)
  const layer = L.layerGroup();        // water supply + destructions
  const otherLayer = L.layerGroup();   // monitoring + other non-water uses
  if (A.layersCtl) {
    A.layersCtl.addOverlay(layer, `<span class="lg lg-sdo"></span><span class="lg lg-sdo-d"></span> ${esc(cfg.label)}`);
    A.layersCtl.addOverlay(otherLayer, `<span class="lg lg-sdo-m"></span> ${esc(cfg.otherLabel)}`);
  }
  if (cfg.defaultOn) layer.addTo(map);

  let manifestP = null, matchedP = null, matched = null;
  const tileP = new Map();   // tile key -> Promise(tile json)
  const drawn = { main: new Set(), other: new Set() };
  const records = {};

  function loadManifest() {
    if (!manifestP) manifestP = fetch(cfg.manifestUrl, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null))
      .then((m) => (m && m.tiles ? m : null)).catch(() => null);
    return manifestP;
  }
  function loadMatched() {
    if (!matchedP) matchedP = fetch(cfg.matchedUrl, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null))
      .then((j) => { matched = (j && j.permits) || {}; return matched; }).catch(() => ({}));
    return matchedP;
  }
  /** County Record_ID -> [[WCRNumber, pdf, how]] of state reports matched to it by the build (null if none / not loaded). */
  function matchedFor(permit) {
    if (!matched) { loadMatched(); return null; }
    return matched[String(permit || '').trim().toUpperCase()] || null;
  }
  /** HTML line for a County permit popup: the state WCR(s) on file for it. */
  function countyLinkHtml(permit) {
    const m = matchedFor(permit);
    if (!m || !m.length) return '';
    return `<div class="sdo-link">📄 State WCR on file: ${m.map(([w, pdf]) => (/^https:\/\//i.test(pdf || '')
      ? `<a href="${esc(pdf)}" target="_blank" rel="noopener">${esc(w)}</a>` : esc(w))).join(', ')}</div>`;
  }

  const approxOf = (r) => !r.acc || /centroid/i.test(r.acc) || /TRS/i.test(r.llm || '') || /^>/.test(r.acc);
  const KIND = { w: 'Water well', d: 'Destruction', m: 'Monitoring / other' };
  function row(k, v) { return v == null || v === '' ? '' : `<tr><td>${k}</td><td>${v}</td></tr>`; }

  function detailHtml(r) {
    let warn = '';
    if (/centroid/i.test(r.acc || '')) warn = '⚠ Approximate: DWR placed this pin at the centre of the PLSS section (≈1 sq mi).';
    else if (!r.acc) warn = '⚠ DWR recorded no location accuracy — treat the pin as approximate.';
    else if (/^>/.test(r.acc)) warn = '⚠ DWR location accuracy is worse than 50 ft.';
    const pdf = /^https:\/\//i.test(r.pdf || '')
      ? `<a href="${esc(r.pdf)}" target="_blank" rel="noopener">📄 WCR PDF (DWR Box viewer)</a>`
      : '<span class="muted">No PDF link in the DWR index</span>';
    const depth = [r.cd != null ? `${esc(r.cd)} ft completed` : '', r.dd != null ? `${esc(r.dd)} ft drilled` : ''].filter(Boolean).join(', ');
    const yld = r.y != null ? `${esc(r.y)} ${esc(r.yu || '')}`.trim() : '';
    const drl = r.drl ? esc(r.drl) + (r.lic ? ` (lic ${esc(r.lic)})` : '') : '';
    const loc = [r.loc, r.city].filter(Boolean).map(esc).join(', ');
    const pmt = [r.pmt, r.pdt ? 'issued ' + r.pdt : ''].filter(Boolean).map(esc).join(' · ');
    const end = r.end ? esc(r.end) + (r.bd ? ' <span class="sdo-warn">(date in the future — DWR typo)</span>' : '') : '<span class="muted">not recorded</span>';
    return `<h3>${esc(r.wcr)}</h3>
      <table>
        ${row('Permit', pmt || '<span class="muted">none on report</span>')}${row('Completed', end)}${row('Received', esc(r.rcv))}
        ${row('Use', esc(r.use || 'not recorded'))}${row('Record', esc(r.rt))}
        ${row('Depth', depth)}${row('SWL', r.swl != null ? esc(r.swl) + ' ft' : '')}${row('Yield', yld)}${row('Method', esc(r.m))}
        ${row('Casing', r.csg != null ? esc(r.csg) + ' in' : '')}${row('Driller', drl)}${row('Location', loc)}${row('APN', esc(r.apn))}
        ${row('Lat / Lon', `${(+r.lat).toFixed(5)}, ${(+r.lon).toFixed(5)}`)}${row('Accuracy', `${esc(r.acc || 'not recorded')}${r.llm ? ` (${esc(r.llm)})` : ''}`)}
      </table>
      ${warn ? `<div class="sdo-warn">${warn}</div>` : ''}
      <div>${pdf}</div>`;
  }

  function popupFor(stack) {
    const box = document.createElement('div'); box.className = 'popup';
    const n = stack.length, k = stack[0].k;
    const head = `<span class="sdo-tag ${k}">San Diego · state WCR (DWR) · ${KIND[k]}</span>${n > 1 ? `<div><b>${n} WCRs at this point</b></div>` : ''}`;
    const body = n > 1 ? `<div class="list">${stack.map((r) => `<div class="item">${detailHtml(r)}</div>`).join('')}</div>` : detailHtml(stack[0]);
    box.innerHTML = `${head}${body}<div style="margin-top:4px"><button type="button" class="small">Search wells here</button></div>`;
    L.DomEvent.on(box.querySelector('button'), 'click', (ev) => { L.DomEvent.stop(ev); map.closePopup(); A.setLocation(+stack[0].lat, +stack[0].lon, 'SD state WCR ' + stack[0].wcr); });
    return box;
  }

  function draw(t, which) {
    const target = which === 'main' ? layer : otherLayer;
    const stacks = new Map();
    for (const r of Object.values(t.wcrs || {})) {
      records[r.wcr] = r;
      if ((r.k === 'm') !== (which === 'other')) continue;
      const key = `${r.lat},${r.lon},${r.k}`;
      if (!stacks.has(key)) stacks.set(key, []);
      stacks.get(key).push(r);
    }
    for (const stack of stacks.values()) {
      stack.sort((a, b) => String(b.end || b.rcv || '').localeCompare(String(a.end || a.rcv || '')));
      const k = stack[0].k, approx = stack.every(approxOf), multi = stack.length > 1;
      const o = k === 'd'
        ? { radius: multi ? 8 : 6, color: cfg.destroyRing, weight: 3, fillColor: cfg.color, fillOpacity: 0.55, dashArray: null }
        : k === 'm'
          ? { radius: multi ? 6 : 4.5, color: cfg.otherColor, weight: 2, fillColor: cfg.otherColor, fillOpacity: 0.15, dashArray: approx ? '3 3' : null }
          : { radius: multi ? 8 : 6, color: cfg.color, weight: 2, fillColor: cfg.color, fillOpacity: approx ? 0.25 : 0.85, dashArray: approx ? '3 3' : null };
      L.circleMarker([+stack[0].lat, +stack[0].lon], { pane: 'sdOswcr', bubblingMouseEvents: false, className: 'sdo-' + k, ...o })
        .bindPopup(() => popupFor(stack), { maxWidth: 310, maxHeight: 320 })
        .bindTooltip(multi ? `${stack.length} SD state WCRs` : `${esc(stack[0].wcr)} · ${KIND[k]}`, { direction: 'top' })
        .addTo(target);
    }
  }

  function getTile(key, t) {
    if (!tileP.has(key)) {
      const base = cfg.manifestUrl.replace(/[^/]*$/, '');
      tileP.set(key, fetch(`${base}tiles/${key}.json?v=${t.h}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((j) => { if (!j) tileP.delete(key); return j; }));
    }
    return tileP.get(key);
  }

  let busy = false, again = false;
  async function refresh() {
    if (busy) { again = true; return; }
    if (map.getZoom() < (cfg.minZoom || 0)) return;
    const want = [['main', layer], ['other', otherLayer]].filter(([, l]) => map.hasLayer(l)).map(([w]) => w);
    if (!want.length) return;
    busy = true;
    try {
      const m = await loadManifest();
      if (!m) return;
      const b = map.getBounds().pad(0.2);
      const need = Object.entries(m.tiles).filter(([k, t]) => t.b[0] <= b.getNorth() && t.b[2] >= b.getSouth()
        && t.b[1] <= b.getEast() && t.b[3] >= b.getWest() && want.some((w) => !drawn[w].has(k)));
      for (let i = 0; i < need.length; i += 6) {
        await Promise.all(need.slice(i, i + 6).map(async ([k, t]) => {
          const j = await getTile(k, t);
          if (!j) return;
          for (const w of want) if (!drawn[w].has(k)) { drawn[w].add(k); draw(j, w); }
        }));
      }
    } finally { busy = false; if (again) { again = false; refresh(); } }
  }

  map.on('moveend overlayadd', refresh);
  refresh();
  loadMatched();
  global.WellsSdOswcr = { layer, otherLayer, refresh, loadManifest, loadMatched, matchedFor, countyLinkHtml, records, drawn, detailHtml };
})(typeof window !== 'undefined' ? window : globalThis);
