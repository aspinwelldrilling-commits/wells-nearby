/* Wells Nearby — San Bernardino County overlays.
 * 1) State DWR OSWCR snapshot: data/sb-oswcr/manifest.json + tiles/<iy>_<ix>.json (0.025° grid), tools/build_sb_oswcr.py.
 *    Water wells + destructions (on), monitoring & other (off). Section-centroid points (`ap`) are dashed / hollow = approximate.
 * 2) County well permits from the weekly Environmental Health PDF: data/sbcounty-permits/permits.json,
 *    tools/sb_weekly_permits.py. Rose squares at the APN parcel centre; dashed square = PLSS section centre (approximate).
 * Not merged into the search table / stats. */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG, A = global.WellsApp;
  const cfg = C && C.sbCounty;
  if (!A || !A.map || !cfg || typeof L === 'undefined') return;
  const map = A.map;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const st = document.createElement('style');
  st.textContent = `.lg-sbo{border-radius:50%;background:${cfg.color};border:2px solid #fff;box-shadow:0 0 0 1px #999}
.lg-sbo-d{border-radius:50%;background:${cfg.color};border:3px solid ${cfg.destroyRing};box-sizing:border-box}
.lg-sbo-m{border-radius:50%;background:transparent;border:2px solid ${cfg.otherColor}}
.lg-sbp{background:${cfg.permitColor};border:2px solid #fff;box-shadow:0 0 0 1px #999;border-radius:2px}
.sbp-icon div{width:12px;height:12px;background:${cfg.permitColor};border:2px solid #fff;box-shadow:0 0 0 1px #333;box-sizing:border-box}
.sbp-icon.ap div{background:rgba(225,29,72,.25);border:2px dashed ${cfg.permitColor};box-shadow:none}
.sbp-icon.d div{border:3px solid #111827}
.popup .sbo-tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:#ccfbf1;color:#115e59;margin-bottom:4px}
.popup .sbo-tag.d{background:#1f2937;color:#fff}.popup .sbo-tag.m{background:#e2e8f0;color:#334155}.popup .sbo-tag.p{background:#ffe4e6;color:#9f1239}
.sbo-warn{color:#b45309;font-size:12px;margin:2px 0}`;
  document.head.appendChild(st);
  map.createPane('sbOswcr').style.zIndex = 452;
  const layer = L.layerGroup(), otherLayer = L.layerGroup(), permitLayer = L.layerGroup();
  if (A.layersCtl) {
    A.layersCtl.addOverlay(layer, `<span class="lg lg-sbo"></span><span class="lg lg-sbo-d"></span> ${esc(cfg.label)}`);
    A.layersCtl.addOverlay(otherLayer, `<span class="lg lg-sbo-m"></span> ${esc(cfg.otherLabel)}`);
    A.layersCtl.addOverlay(permitLayer, `<span class="lg lg-sbp"></span> ${esc(cfg.permitLabel)}`);
  }
  if (cfg.defaultOn) { layer.addTo(map); permitLayer.addTo(map); }
  const KIND = { w: 'Water well', d: 'Destruction', m: 'Monitoring / other' };
  const row = (k, v) => (v == null || v === '' ? '' : `<tr><td>${k}</td><td>${v}</td></tr>`);
  const fmtLL = (r) => `${(+r.lat).toFixed(5)}, ${(+r.lon).toFixed(5)}`;
  const apnFmt = (a) => String(a || '').replace(/^(\d{4})(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3-$4');
  function searchBtn(box, lat, lon, why) {
    L.DomEvent.on(box.querySelector('button'), 'click', (ev) => { L.DomEvent.stop(ev); map.closePopup(); A.setLocation(+lat, +lon, why); });
    return box;
  }

  function wcrPopup(r) {
    const box = document.createElement('div'); box.className = 'popup';
    const moved = r.dll ? ` DWR's own point was ${(+r.dll[0]).toFixed(5)}, ${(+r.dll[1]).toFixed(5)}.` : '';
    const warn = r.pl === 'apn' ? (r.ap ? `⚠ Approximate: pin at the centre of the report's parcel (APN ${esc(r.apn)}, ≈${esc(r.pac)} acres — large parcel).${moved}`
        : `Pin at the centre of the report's parcel (APN ${esc(r.apn)}, ≈${esc(r.pac)} acres); the well is on that parcel.${moved}`)
      : r.pl === 'sec' ? '⚠ Approximate: DWR gave no coordinates; pin at the centre of the report\'s PLSS section (≈1 sq mi).'
      : r.pl === 'fix' ? `⚠ DWR coordinates had a sign / order typo; corrected here.${moved}`
      : r.ap ? '⚠ Approximate: DWR placed this pin at the centre of the PLSS section (≈1 sq mi).'
      : !r.acc ? '⚠ DWR recorded no location accuracy — treat the pin as approximate.' : /^>/.test(r.acc) ? '⚠ DWR location accuracy is worse than 50 ft.' : '';
    const depth = [r.cd != null ? `${esc(r.cd)} ft completed` : '', r.dd != null ? `${esc(r.dd)} ft drilled` : ''].filter(Boolean).join(', ');
    const pdf = /^https:\/\//i.test(r.pdf || '') ? `<a href="${esc(r.pdf)}" target="_blank" rel="noopener">📄 WCR PDF (DWR Box viewer)</a>` : '<span class="muted">No PDF link in the DWR index</span>';
    box.innerHTML = `<span class="sbo-tag ${r.k}">San Bernardino · state WCR (DWR) · ${KIND[r.k]}</span><h3>${esc(r.wcr)}</h3><table>
      ${row('Permit', esc([r.pmt, r.pdt ? 'issued ' + r.pdt : ''].filter(Boolean).join(' · ')) || '<span class="muted">none on report</span>')}
      ${row('Completed', r.end ? esc(r.end) + (r.bd ? ' (date in the future — DWR typo)' : '') : '<span class="muted">not recorded</span>')}${row('Received', esc(r.rcv))}
      ${row('Use', esc(r.use || 'not recorded'))}${row('Record', esc(r.rt))}${row('Depth', depth)}${row('SWL', r.swl != null ? esc(r.swl) + ' ft' : '')}
      ${row('Yield', r.y != null ? `${esc(r.y)} ${esc(r.yu || '')}` : '')}${row('Method', esc(r.m))}${row('Casing', r.csg != null ? esc(r.csg) + ' in' : '')}
      ${row('Driller', r.drl ? esc(r.drl) + (r.lic ? ` (lic ${esc(r.lic)})` : '') : '')}${row('Location', [r.loc, r.city].filter(Boolean).map(esc).join(', '))}${row('APN', esc(r.apn))}
      ${row('Lat / Lon', fmtLL(r))}${row('Accuracy', `${esc(r.acc || 'not recorded')}${r.llm ? ` (${esc(r.llm)})` : ''}`)}</table>
      ${warn ? `<div class="sbo-warn">${warn}</div>` : ''}<div>${pdf}</div><div style="margin-top:4px"><button type="button" class="small">Search wells here</button></div>`;
    return searchBtn(box, r.lat, r.lon, 'SB state WCR ' + r.wcr);
  }

  function permitPopup(p) {
    const box = document.createElement('div'); box.className = 'popup';
    const where = p.pl === 'apn' ? `Parcel centre of APN ${esc(p.tax || apnFmt(p.apn))}${p.ac ? ` (≈${esc(p.ac)} acres)` : ''}`
      : `<span class="sbo-warn">⚠ Approximate: centre of ${esc(p.trs || 'the PLSS section')} (≈1 sq mi) — APN "${esc(p.apnRaw)}" not found as a parcel</span>`;
    box.innerHTML = `<span class="sbo-tag p">San Bernardino County well permit · ${KIND[p.k]}</span><h3>Permit ${esc(p.pn)}</h3><table>
      ${row('Record', esc(p.rid))}${row('Entered', esc(p.ent))}${row('Type', esc(p.desc))}${row('Work', esc(p.work))}
      ${row('Contractor', esc(p.ctr))}${row('City', esc(p.city))}${row('APN', esc(p.apnRaw && /^\d{13}$/.test(p.apnRaw) ? apnFmt(p.apnRaw) : p.apnRaw))}
      ${row('TRS', `T${esc(p.twn)} R${esc(p.rng)} Sec ${esc(p.sec)} SBM`)}${row('Lat / Lon', fmtLL(p))}</table>
      <div class="muted small">${where}. From the County weekly report (week ending ${esc(p.week)}); no depth / GPS on the permit list.</div>
      <div style="margin-top:4px"><button type="button" class="small">Search wells here</button></div>`;
    return searchBtn(box, p.lat, p.lon, 'SB permit ' + p.pn);
  }

  let permitsP = null;
  function loadPermits() {
    if (!permitsP) permitsP = fetch(cfg.permitsUrl, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => {
      if (!j) { permitsP = null; return null; }
      for (const p of Object.values(j.permits || {})) {
        if (p.lat == null) continue;
        const icon = L.divIcon({ className: `sbp-icon ${p.pl === 'apn' ? '' : 'ap'} ${p.k === 'd' ? 'd' : ''}`, html: '<div></div>', iconSize: [12, 12] });
        L.marker([p.lat, p.lon], { icon, pane: 'sbOswcr', title: `SB permit ${p.pn}` }).bindPopup(() => permitPopup(p), { maxWidth: 310, maxHeight: 340 })
          .bindTooltip(`SB permit ${esc(p.pn)} · ${esc(p.desc)} · ${esc(p.work)}${p.pl === 'apn' ? '' : ' (approx.)'}`, { direction: 'top' }).addTo(permitLayer);
      }
      return j;
    });
    return permitsP;
  }

  let manifestP = null;
  const tileP = new Map(), drawn = { main: new Set(), other: new Set() }, records = {};
  const loadManifest = () => (manifestP = manifestP || fetch(cfg.manifestUrl, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((m) => (m && m.tiles ? m : null)).catch(() => null));
  function getTile(key, t) {
    if (!tileP.has(key)) tileP.set(key, fetch(`${cfg.manifestUrl.replace(/[^/]*$/, '')}tiles/${key}.json?v=${t.h}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((j) => { if (!j) tileP.delete(key); return j; }));
    return tileP.get(key);
  }
  const groups = [];
  function placeGroup(g) {
    if (g.markers.length < 2) return;
    const c = map.project([g.lat, g.lon]);
    g.markers.forEach((m, i) => { const a = i * 2.4, rad = 9 + 4.5 * Math.sqrt(i); m.setLatLng(map.unproject(c.add(L.point(rad * Math.cos(a), rad * Math.sin(a))))); });
  }
  map.on('zoomend', () => groups.forEach(placeGroup));
  function draw(t, which) {
    const target = which === 'main' ? layer : otherLayer, byPt = new Map();
    for (const r of Object.values(t.wcrs || {})) {
      records[r.wcr] = r;
      if ((r.k === 'm') !== (which === 'other')) continue;
      const key = `${r.lat},${r.lon}`;
      (byPt.get(key) || byPt.set(key, []).get(key)).push(r);
    }
    for (const list of byPt.values()) {
      // water wells first in a stack, then destructions; only the first ~40 per point are drawn (section centroids pile up)
      list.sort((a, b) => ('wdm'.indexOf(a.k) - 'wdm'.indexOf(b.k)) || String(b.end || '').localeCompare(String(a.end || '')));
      const g = { lat: +list[0].lat, lon: +list[0].lon, markers: [] };
      for (const r of list.slice(0, 40)) {
        const approx = r.pl === 'apn' ? !!r.ap : (!!r.ap || !r.acc || /^>/.test(r.acc));
        const o = r.k === 'd' ? { radius: 6, color: cfg.destroyRing, weight: 3, fillColor: cfg.color, fillOpacity: 0.55 }
          : r.k === 'm' ? { radius: 4.5, color: cfg.otherColor, weight: 2, fillColor: cfg.otherColor, fillOpacity: 0.15, dashArray: approx ? '3 3' : null }
            : { radius: 6, color: cfg.color, weight: 2, fillColor: cfg.color, fillOpacity: approx ? 0.25 : 0.85, dashArray: approx ? '3 3' : null };
        g.markers.push(L.circleMarker([g.lat, g.lon], { pane: 'sbOswcr', bubblingMouseEvents: false, className: 'sbo-' + r.k, ...o })
          .bindPopup(() => wcrPopup(r), { maxWidth: 310, maxHeight: 320 })
          .bindTooltip(`${esc(r.wcr)} · ${KIND[r.k]}${r.ap ? ' (section-level)' : r.pl === 'apn' ? ' (parcel)' : ''}`, { direction: 'top' }).addTo(target));
      }
      if (g.markers.length > 1) { groups.push(g); placeGroup(g); }
    }
  }
  let busy = false, again = false;
  async function refresh() {
    if (map.hasLayer(permitLayer)) loadPermits();
    if (busy) { again = true; return; }
    if (map.getZoom() < (cfg.minZoom || 0)) return;
    const want = [['main', layer], ['other', otherLayer]].filter(([, l]) => map.hasLayer(l)).map(([w]) => w);
    if (!want.length) return;
    busy = true;
    try {
      const m = await loadManifest();
      if (!m) return;
      const b = map.getBounds().pad(0.2);
      const need = Object.entries(m.tiles).filter(([k, t]) => t.b[0] <= b.getNorth() && t.b[2] >= b.getSouth() && t.b[1] <= b.getEast() && t.b[3] >= b.getWest() && want.some((w) => !drawn[w].has(k)));
      for (let i = 0; i < need.length; i += 6) {
        await Promise.all(need.slice(i, i + 6).map(async ([k, t]) => {
          const j = await getTile(k, t);
          if (j) for (const w of want) if (!drawn[w].has(k)) { drawn[w].add(k); draw(j, w); }
        }));
      }
    } finally { busy = false; if (again) { again = false; refresh(); } }
  }
  map.on('moveend overlayadd', refresh);
  refresh();
  global.WellsSbCounty = { layer, otherLayer, permitLayer, refresh, loadManifest, loadPermits, records, drawn };
})(typeof window !== 'undefined' ? window : globalThis);
