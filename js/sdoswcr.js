/* Wells Nearby — San Diego County state well completion reports (DWR OSWCR snapshot) as map overlays.
 * Data: data/sd-oswcr/manifest.json + tiles/<iy>_<ix>.json (0.025° grid), built by tools/build_sd_oswcr.py from the DWR
 * OSWCR index (CountyName = San Diego). The County DEHQ permit layer stops ~2020, so these fill 2020 -> today plus every older
 * state report that has no County permit. Reports matched to a County permit are NOT drawn again; their WCR link is in
 * data/sd-oswcr/matched.json and is shown in that County permit's popup (WellsSdOswcr.matchedFor).
 * Accuracy: wells with a real point location (pq != 's') get one marker each (co-located ones fan out on a small pixel
 * spiral); popup/tooltip show the well's own coords and SanGIS APN (tools/assign_sd_apn.py). Section-level wells (DWR put
 * them at the centre of their PLSS section) get NO point: the wells sharing a section are drawn as one approximate area,
 * the BLM PLSS section polygon (data/sd-oswcr/sections.json, tools/build_sd_sections.py), or a soft ~section-size circle
 * where BLM has no section. Tapping / hovering an area lists its wells and says the location is section-level only.
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
.sdo-link{font-size:12px;margin:3px 0}
.lg-sdo-a{border:2px dashed ${cfg.color};background:rgba(101,163,13,.12);border-radius:2px;box-sizing:border-box}
.sdo-approx{background:#fef3c7;color:#92400e;font-size:12px;font-weight:600;padding:3px 6px;border-radius:4px;margin:3px 0}
.sdo-det ul{max-height:220px;overflow-y:auto}.sdo-det summary{cursor:pointer;font-size:12px;margin-top:2px}
.sdo-wl{margin:0;padding:0;list-style:none;font-size:12px}.sdo-wl li{border-top:1px solid #e5e7eb;padding:3px 0}
.sdo-ic{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px;box-sizing:border-box}
.sdo-ic.w{background:${cfg.color}}.sdo-ic.d{background:${cfg.color};border:3px solid ${cfg.destroyRing}}.sdo-ic.m{border:2px solid ${cfg.otherColor}}`;
  document.head.appendChild(st);

  map.createPane('sdOswcr').style.zIndex = 450;   // under the search pins (markerPane 600)
  const areaPane = map.createPane('sdOswcrArea'); areaPane.style.zIndex = 430;   // approximate section areas sit under every pin
  areaPane.style.pointerEvents = 'none';   // display only: taps / touch adjustment go to the map and pins, never to this SVG
  const layer = L.layerGroup();        // water supply + destructions
  const otherLayer = L.layerGroup();   // monitoring + other non-water uses
  if (A.layersCtl) {
    A.layersCtl.addOverlay(layer, `<span class="lg lg-sdo"></span><span class="lg lg-sdo-d"></span> ${esc(cfg.label)}<br>`
      + `<small style="margin-left:22px"><span class="lg lg-sdo-a"></span> dashed square = approximate area: DWR located those wells only to a PLSS section (≈1 sq mi), no exact point / APN</small>`);
    A.layersCtl.addOverlay(otherLayer, `<span class="lg lg-sdo-m"></span> ${esc(cfg.otherLabel)} <small>(grey dashed areas = section-level)</small>`);
  }
  if (cfg.defaultOn) layer.addTo(map);

  let manifestP = null, matchedP = null, matched = null, sectionsP = null, sections = null;
  function loadSections(m) {
    if (!sectionsP) {
      const base = cfg.manifestUrl.replace(/[^/]*$/, ''), s = m.sections || {};
      sectionsP = s.url ? fetch(`${base}${s.url}?v=${s.h || ''}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
        .then((j) => { sections = j || {}; return sections; }) : Promise.resolve((sections = {}));
    }
    return sectionsP;
  }
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

  const fmtLL = (r) => `${(+r.lat).toFixed(5)}, ${(+r.lon).toFixed(5)}`;
  function apnText(r) {
    if (r.pa) return String(r.pa).replace(/^(\d{3})(\d{3})(\d{2})(\d{2})$/, '$1-$2-$3-$4');
    return r.pq === 's' ? 'no APN — section-level location' : 'no APN — point is in no parcel (road / water)';
  }

  function popupFor(r) {
    const box = document.createElement('div'); box.className = 'popup';
    box.innerHTML = `<span class="sdo-tag ${r.k}">San Diego · state WCR (DWR) · ${KIND[r.k]}</span>
      <div class="sdo-id"><b>${esc(fmtLL(r))}</b><br>APN: <b class="sdo-apn">${esc(apnText(r))}</b>${r.pa ? `<br>Address: <span class="sdo-addr">${r.ad ? `<b>${esc(r.ad)}</b>` : '<i>no address on file</i>'}</span>` : ''}</div>${detailHtml(r)}
      <div style="margin-top:4px"><button type="button" class="small">Search wells here</button></div>`;
    L.DomEvent.on(box.querySelector('button'), 'click', (ev) => { L.DomEvent.stop(ev); map.closePopup(); A.setLocation(+r.lat, +r.lon, 'SD state WCR ' + r.wcr); });
    return box;
  }

  // One marker per well (no grouping). DWR stacks many WCRs on one point (section centroids), so wells sharing exact
  // coordinates are fanned out on a small pixel spiral around the true point (recomputed on zoom); popups show true coords.
  const groups = [];   // [{ lat, lon, markers: [] }]
  function placeGroup(g) {
    if (g.markers.length < 2) return;
    const c = map.project([g.lat, g.lon]);
    g.markers.forEach((m, i) => {
      const ang = i * 2.4, rad = 9 + 4.5 * Math.sqrt(i);
      m.setLatLng(map.unproject(c.add(L.point(rad * Math.cos(ang), rad * Math.sin(ang)))));
    });
  }
  map.on('zoomend', () => groups.forEach(placeGroup));

  // ---- approximate section areas (section-level wells): one polygon per section per overlay, listing its wells
  const areas = { main: new Map(), other: new Map() };   // area key -> { shape, wells: Map(wcr -> r), lab }
  const KORDER = { w: 0, d: 1, m: 2 };
  function areaLabel(a) {
    const r0 = a.wells.values().next().value;
    const s = r0.sx && sections && sections[r0.sx];
    return s ? `${s.lab}${s.mer ? ', ' + s.mer + ' Meridian' : ''}` : (r0.trs ? `${r0.trs} per DWR; unsurveyed / land-grant area, shown as a section-size circle` : 'section not identified; shown as a section-size circle');
  }
  function wellsSorted(a) {
    return [...a.wells.values()].sort((x, y) => (KORDER[x.k] - KORDER[y.k]) || String(y.end || y.rcv || '').localeCompare(String(x.end || x.rcv || '')));
  }
  function wellLine(r) {
    const pdf = /^https:\/\//i.test(r.pdf || '') ? ` · <a href="${esc(r.pdf)}" target="_blank" rel="noopener">PDF</a>` : '';
    const depth = r.cd != null ? `${esc(r.cd)} ft` : r.dd != null ? `${esc(r.dd)} ft drilled` : '— ft';
    const date = r.end ? esc(r.end) + (r.bd ? ' (bad date)' : '') : r.rcv ? 'rcvd ' + esc(r.rcv) : 'no date';
    return `<li><span class="sdo-ic ${r.k}" title="${KIND[r.k]}"></span><b>${esc(r.wcr)}</b> · ${esc(r.use || KIND[r.k])}${r.k === 'd' ? ' (destruction)' : ''} · ${date} · ${depth} · ${esc(r.drl || 'driller not recorded')}${pdf}</li>`;
  }
  function areaHeader(a) {
    const n = a.wells.size;
    return `<div class="sdo-approx">⚠ Approximate location: section-level only (${esc(areaLabel(a))}), no APN.</div>
      <div class="muted small">DWR recorded ${n === 1 ? 'this well' : `these ${n} wells`} only to a PLSS section (≈1 sq mi). The well can be anywhere in the outlined area; no GPS point.</div>`;
  }
  function areaTooltip(a) {
    const ws = wellsSorted(a), more = ws.length - 6;
    return `<b>Approximate area · ${ws.length} WCR${ws.length > 1 ? 's' : ''}</b><br>Section-level only (${esc(areaLabel(a))}), no APN<br>`
      + ws.slice(0, 6).map((r) => `<span class="sdo-ic ${r.k}"></span>${esc(r.wcr)} · ${esc((r.use || KIND[r.k]).replace(/^Water Supply\s*/i, ''))} · ${esc((r.end || r.rcv || '').slice(0, 4) || '—')}`).join('<br>')
      + (more > 0 ? `<br>+${more} more — tap for the full list` : '');
  }
  function styleArea(a, which) {
    const ks = new Set([...a.wells.values()].map((r) => r.k));
    const col = which === 'other' ? cfg.otherColor : ks.has('w') ? cfg.color : cfg.destroyRing;
    return { color: col, weight: 2, dashArray: '6 5', fillColor: which === 'other' ? cfg.otherColor : cfg.color, fillOpacity: 0.07 };
  }
  function addToArea(r, which, target) {
    const sec = r.sx && sections && sections[r.sx];
    const key = sec ? 'S' + r.sx : `P${r.lat},${r.lon}`;
    let a = areas[which].get(key);
    if (!a) {
      a = { wells: new Map() };
      // Not interactive: the area must never swallow a normal map tap ("Search here", parcel APN, septic tools). Taps are
      // handled by tapExtras() (adds the area's well list to the normal tap popup) and hover by the map mousemove below.
      const o = { pane: 'sdOswcrArea', interactive: false, className: 'sdo-area sdo-area-' + which };
      a.shape = sec ? L.polygon(sec.rings.map((ring) => ring.map(([x, y]) => [y, x])), o) : L.circle([+r.lat, +r.lon], { radius: 900, ...o });
      a.sec = sec; a.which = which;
      a.shape.sdoArea = a;
      a.shape.addTo(target);
      areas[which].set(key, a);
    }
    a.wells.set(r.wcr, r);
    a.shape.setStyle(styleArea(a, which));
  }

  function inRings(lat, lon, rings) {
    let c = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  /** Approximate areas (on visible overlays) containing a point. */
  function areasAt(ll) {
    const out = [];
    for (const [which, l] of [['main', layer], ['other', otherLayer]]) {
      if (!map.hasLayer(l)) continue;
      for (const a of areas[which].values()) {
        if (a.sec ? (a.shape.getBounds().contains(ll) && inRings(ll.lat, ll.lng, a.sec.rings)) : map.distance(ll, a.shape.getLatLng()) <= a.shape.getRadius()) out.push(a);
      }
    }
    return out;
  }
  /** Called by the normal map-tap popup (js/app.js searchHerePopup): appends the approximate areas under the tap. */
  function tapExtras(ll, box) {
    const hit = areasAt(ll);
    if (!hit.length) return;
    const d = document.createElement('div'); d.className = 'sdo-tapareas';
    // compact by default (the tap popup must stay small on a phone): header + collapsible well list
    d.innerHTML = hit.map((a) => `<details class="sdo-det"><summary class="sdo-approx">⚠ Approximate: ${a.wells.size} SD state WCR${a.wells.size > 1 ? 's' : ''} here</summary>${areaHeader(a)}<ul class="sdo-wl">${wellsSorted(a).map(wellLine).join('')}</ul></details>`).join('');
    box.appendChild(d);
  }
  // desktop hover: one tooltip that follows the mouse while it is over an approximate area
  const hoverTip = L.tooltip({ direction: 'top', offset: [0, -8], className: 'sdo-area-tip' });
  let hoverKey = null, hoverT = 0;
  const canHover = !global.matchMedia || global.matchMedia('(hover: hover)').matches;   // touch phones: taps only
  if (canHover) map.on('mousemove', (e) => {
    const now = Date.now(); if (now - hoverT < 60) return; hoverT = now;
    if (map.getContainer().querySelector('.leaflet-interactive:hover')) { if (hoverKey) { map.closeTooltip(hoverTip); hoverKey = null; } return; }
    const hit = areasAt(e.latlng);
    if (!hit.length) { if (hoverKey) { map.closeTooltip(hoverTip); hoverKey = null; } return; }
    const key = hit.map((a) => a.which + (a.sec ? a.wells.values().next().value.sx : a.shape.getLatLng())).join('|');
    hoverTip.setLatLng(e.latlng);
    if (key !== hoverKey) { hoverKey = key; hoverTip.setContent(hit.map(areaTooltip).join('<hr style="margin:3px 0">') + '<br><i>Tap / click for the full list</i>'); }
    if (!map.hasLayer(hoverTip)) hoverTip.addTo(map);
  });
  map.on('mouseout', () => { map.closeTooltip(hoverTip); hoverKey = null; });

  function draw(t, which) {
    const target = which === 'main' ? layer : otherLayer;
    const byPt = new Map();
    for (const r of Object.values(t.wcrs || {})) {
      records[r.wcr] = r;
      if ((r.k === 'm') !== (which === 'other')) continue;
      if (r.pq === 's') { addToArea(r, which, target); continue; }
      const key = `${r.lat},${r.lon}`;
      if (!byPt.has(key)) byPt.set(key, []);
      byPt.get(key).push(r);
    }
    for (const list of byPt.values()) {
      list.sort((a, b) => String(a.wcr).localeCompare(String(b.wcr)));
      const g = { lat: +list[0].lat, lon: +list[0].lon, markers: [] };
      for (const r of list) {
        const k = r.k, approx = approxOf(r);
        const o = k === 'd'
          ? { radius: 6, color: cfg.destroyRing, weight: 3, fillColor: cfg.color, fillOpacity: 0.55, dashArray: null }
          : k === 'm'
            ? { radius: 4.5, color: cfg.otherColor, weight: 2, fillColor: cfg.otherColor, fillOpacity: 0.15, dashArray: approx ? '3 3' : null }
            : { radius: 6, color: cfg.color, weight: 2, fillColor: cfg.color, fillOpacity: approx ? 0.25 : 0.85, dashArray: approx ? '3 3' : null };
        const mk = L.circleMarker([g.lat, g.lon], { pane: 'sdOswcr', bubblingMouseEvents: false, className: 'sdo-' + k, ...o })
          .bindPopup(() => popupFor(r), { maxWidth: 310, maxHeight: 320 })
          .bindTooltip(`${esc(r.wcr)} · ${KIND[k]}<br>${esc(fmtLL(r))}<br>APN ${esc(apnText(r))}${r.pa ? '<br>' + esc(r.ad || 'no address on file') : ''}`, { direction: 'top' })
          .addTo(target);
        mk.sdoWcr = r.wcr;
        g.markers.push(mk);
      }
      if (g.markers.length > 1) { groups.push(g); placeGroup(g); }
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
      await loadSections(m);
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
  /** Parcel APN + situs address for a WCR drawn by this layer (null if not an exact-point SD well / tile not loaded). */
  function parcelFor(wcr) {
    const r = records[String(wcr || '')];
    return r && r.pa ? { apn: apnText(r), address: r.ad || null } : null;
  }
  global.WellsSdOswcr = { parcelFor, areasAt, tapExtras, areas, areaLabel, apnText, layer, otherLayer, refresh, loadManifest, loadMatched, matchedFor, countyLinkHtml, records, drawn, detailHtml };
})(typeof window !== 'undefined' ? window : globalThis);
