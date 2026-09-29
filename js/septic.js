/* Wells Nearby — septic / sewer for proposed well sites and tapped parcels.
 *  (b) Septic records from the DEHQ Environmental Health Document Library: dashed APN first (OWTS Layout / OWTS Permit /
 *      Land Use Archive-Parcel), then street number + name if the parcel has an address; merged by FileRecordId.
 *      Optional "neighbors on this assessor page" search (book-page prefix, e.g. 284-291).
 *  (a) Sewer or septic status of the parcel + neighbors within ~200 ft from the County's WW_Septic_Sewer_Public layer
 *      (screening layer, May 2025). Optional map layers: sewer service areas and public sewer mains (County SD, City of SD).
 *  (c) Setback rings (50 / 100 / 150 ft) around a site and tap-to-mark tank, pit, leach line, sewer line, tight line with
 *      live distance checks. Marks are saved with the site on this device.
 * Network: only APNs, street number/name and coordinates go to County / SANDAG servers — never customer data. */
(function () {
  'use strict';
  const C = window.WELLS_CONFIG, SC = C.septic, K = window.SepticCore, A = window.WellsApp, map = A.map, W = window.WellsDocs;
  const WS = () => window.WellsSites;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);
  const M_PER_FT = 1 / K.FT_PER_M;

  async function getJson(url, params, timeoutMs = SC.timeoutMs) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url + '?' + new URLSearchParams(params), { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'server error');
      return j;
    } finally { clearTimeout(t); }
  }
  // Re-layout the open popup after its content grew (not popup.update(): that re-runs a function content = new popup body)
  const refreshPopup = () => { const p = map._popup; if (p && map.hasLayer(p) && p._container) { p._updateLayout(); p._updatePosition(); p._adjustPan(); } };

  // =====================================================================================================================
  // (a) sewer / septic status
  async function fetchStatus(apn, lat, lon) {
    const digits = K.apnDigits(apn).slice(0, 10);
    const fields = 'apn,sewer_septic_parcel_designation,septic_sewer_designation_confid';
    const own = digits.length === 10 ? getJson(SC.wwUrl, { where: `apn='${digits}'`, outFields: fields, returnGeometry: 'false', f: 'json' }) : Promise.resolve({ features: [] });
    const nb = lat != null ? getJson(SC.wwUrl, { geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      distance: String(SC.neighborM), units: 'esriSRUnit_Meter', outFields: fields, returnGeometry: 'false', resultRecordCount: '60', f: 'json' }) : Promise.resolve({ features: [] });
    const [o, n] = await Promise.all([own, nb]);
    const ownF = (o.features || [])[0];
    const counts = {};
    const neighbors = (n.features || []).map((f) => f.attributes).filter((a) => a.apn !== digits);
    for (const a of neighbors) { const d = K.designation(a); const k = /sewer/.test(d.key) ? 'sewer' : /septic/.test(d.key) ? 'septic' : 'unknown'; counts[k] = (counts[k] || 0) + 1; }
    return { own: K.designation(ownF ? ownF.attributes : null), hasApn: digits.length === 10, neighbors: neighbors.length, counts, checkedAt: new Date().toISOString() };
  }
  function statusHtml(st, cachedNote) {
    const d = st.own, cls = /^sewer/.test(d.key) ? 'sewer' : /^septic/.test(d.key) ? 'septic' : 'unk';
    const c = st.counts || {};
    const nb = st.neighbors ? `Neighbors within ~200 ft: ${[c.septic ? `<b>${c.septic}</b> septic` : '', c.sewer ? `<b>${c.sewer}</b> sewer` : '', c.unknown ? `${c.unknown} unknown` : ''].filter(Boolean).join(', ')}` : 'No neighboring parcels in the layer within ~200 ft.';
    return `<div class="sep-status ${cls}"><div class="sep-verdict">${cls === 'sewer' ? '🟢' : cls === 'septic' ? '🟤' : '⚪'} <b>${esc(d.short)}</b>
        <small>${d.level != null ? '· ' + esc(K.levelText(d.level)) : ''}</small></div>
      <div class="sep-why">${st.hasApn ? esc(d.text) : 'No APN yet — status needs the parcel number.'}</div>
      <div class="sep-nb">${nb}</div>
      <div class="sep-caveat">${esc(K.SCREENING_NOTE)}${cachedNote ? ' ' + cachedNote : ''}</div></div>`;
  }

  // =====================================================================================================================
  // (b) DEH septic records
  async function fetchRecords(ctx) {
    const lists = [], tried = [], errors = [];
    const keys = [...new Set((ctx.apns || []).map(K.apnDashed).filter(Boolean))];
    for (const k of keys) {   // APN first (primary: addresses change, and the well often comes before the house)
      try { lists.push({ via: 'APN', docs: (await W.searchRaw({ parcel_number: k }, K.SEPTIC_SUBTYPES)).map(K.normDoc) }); tried.push('APN ' + k); }
      catch (e) { errors.push('APN ' + k); }
    }
    const ad = K.addressParts(ctx.parcel, ctx.address);
    if (ad) {
      try { lists.push({ via: 'address', docs: (await W.searchRaw({ street_number: ad.num, street_name: ad.name }, K.SEPTIC_SUBTYPES)).map(K.normDoc) }); tried.push(`${ad.num} ${ad.name}`); }
      catch (e) { errors.push('address'); }
    }
    if (!tried.length && errors.length) throw new Error('library unreachable');
    return { docs: K.mergeDocs(lists), tried, errors, address: ad, keys, checkedAt: new Date().toISOString() };
  }
  const docLine = (d, showApn) => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${d.info.icon} ${esc(d.info.label)}</a>
      <small>${esc(d.permit || '')}${d.description && !/^approved$/i.test(d.description) ? ' · ' + esc(d.description) : ''}${showApn && d.apn ? ' · ' + esc(d.apn) : ''}</small>
      <small class="muted">scanned ${esc(d.scanned)}${d.via && d.via.includes('address') && !d.via.includes('APN') ? ' · found by address' : ''}</small></li>`;
  function recordsHtml(res, cachedNote) {
    const d = res.docs;
    const how = `searched ${res.tried.map(esc).join(' + ')}${res.errors.length ? ` <span class="bad">(${res.errors.map(esc).join(', ')} failed)</span>` : ''}`;
    return `<div class="sep-recs"><div class="sub">Septic records (County DEH library)</div>
      ${d.length ? `<ul class="doclist">${d.map((x) => docLine(x)).join('')}</ul>` : '<div class="muted">No septic layouts, permits or archive files found online.</div>'}
      <div class="muted small">${how}${cachedNote ? ' · ' + cachedNote : ''}. Missing? Older files may be offline — ask DEHQ (public records request).</div></div>`;
  }
  async function neighborsHtml(apn) {
    const page = K.apnPage(apn), own = K.apnSearchKey(apn);
    const docs = (await W.searchRaw({ parcel_number: page }, K.SEPTIC_SUBTYPES)).map(K.normDoc);
    const groups = K.groupNeighbors(docs, own);
    if (!groups.length) return `<div class="muted">No septic records for other parcels on assessor page ${esc(page)}.</div>`;
    return `<div class="muted">${groups.length} other parcel${groups.length > 1 ? 's' : ''} on page ${esc(page)} with septic records (not necessarily next door):</div>
      ${groups.map((g) => `<details class="sep-nbp"><summary>APN ${esc(g.apn)} <small>(${g.docs.length})</small></summary><ul class="doclist">${g.docs.map((x) => docLine(x)).join('')}</ul></details>`).join('')}`;
  }

  // Fills a .sep-box element for a parcel. ctx = {apn, apns, parcel, address, lat, lon, site?}
  function fillBox(box, ctx) {
    const site = ctx.site, cache = site && site.septic;
    const apn = ctx.apn || (ctx.apns || [])[0] || '';
    box.innerHTML = `<div class="sub">🚽 Sewer / septic</div><div class="sep-st"><span class="muted">Checking sewer/septic status…</span></div>
      <div class="sep-rc"><span class="muted">Searching septic records…</span></div>
      ${K.apnPage(apn) ? `<button class="small sep-nbbtn" type="button">🏘 Neighbors on assessor page ${esc(K.apnPage(apn))}</button><div class="sep-nbres"></div>` : ''}`;
    const stEl = box.querySelector('.sep-st'), rcEl = box.querySelector('.sep-rc');
    const saved = (iso) => `saved ${new Date(iso).toLocaleDateString()} (offline copy)`;
    const pStatus = fetchStatus(apn, ctx.lat, ctx.lon).then((st) => { stEl.innerHTML = statusHtml(st); refreshPopup(); return st; })
      .catch(() => { stEl.innerHTML = cache && cache.status ? statusHtml(cache.status, saved(cache.status.checkedAt)) : '<div class="bad">Sewer/septic status unavailable (offline?).</div>'; refreshPopup(); return null; });
    const pRecs = (ctx.apns && ctx.apns.length) || ctx.address ? fetchRecords(ctx).then((res) => { rcEl.innerHTML = recordsHtml(res); refreshPopup(); return res; })
      .catch(() => { rcEl.innerHTML = cache && cache.records ? recordsHtml(cache.records, saved(cache.records.checkedAt)) : '<div class="bad">Septic records unavailable (offline?).</div>'; refreshPopup(); return null; })
      : Promise.resolve((rcEl.innerHTML = '<div class="muted">No APN or address yet — septic records need one.</div>', null));
    // The screening layer is often "Not known" for rural parcels that DO have a septic system on file with DEH: say so.
    Promise.all([pStatus, pRecs]).then(([st, res]) => {
      if (!st || !res || !res.docs || !res.docs.length || /^(sewer|septic)/.test((st.own && st.own.key) || '')) return;
      const permits = [...new Set(res.docs.map((d) => d.permit).filter(Boolean))];
      const el = stEl.querySelector('.sep-status');
      if (el) el.insertAdjacentHTML('beforeend', `<div class="sep-why"><b>🟤 Septic on file:</b> the DEH library has ${res.docs.length} septic record${res.docs.length > 1 ? 's' : ''} for this APN (${permits.map(esc).join(', ')}), so this parcel has (or had) an onsite septic system.</div>`);
      refreshPopup();
    });
    const nbBtn = box.querySelector('.sep-nbbtn');
    if (nbBtn) nbBtn.onclick = async (ev) => {
      ev.stopPropagation(); nbBtn.disabled = true; nbBtn.textContent = 'Searching neighbors…';
      const out = box.querySelector('.sep-nbres');
      try { out.innerHTML = await neighborsHtml(apn); nbBtn.remove(); } catch (e) { out.innerHTML = '<div class="bad">Neighbor search failed (offline?).</div>'; nbBtn.disabled = false; nbBtn.textContent = 'Retry neighbors'; }
      refreshPopup();
    };
    L.DomEvent.disableClickPropagation(box);
    if (site) Promise.all([pStatus, pRecs]).then(async ([st, res]) => {   // offline copy with the site (does not change "updated")
      if (!st && !res) return;
      site.septic = { status: st || (cache && cache.status) || null, records: res ? { docs: res.docs, tried: res.tried, errors: res.errors, checkedAt: res.checkedAt } : (cache && cache.records) || null };
      try { await WS().Store.put(site); } catch (e) { /* storage full / private mode */ }
    });
    return Promise.all([pStatus, pRecs]);
  }
  function siteCtx(s) {
    const apns = [s.apn, s.parcel && s.parcel.apn].filter(Boolean);
    return { site: s, apn: apns[0] || '', apns, parcel: s.parcel, address: s.address || (s.parcel && s.parcel.address) || '', lat: s.lat, lon: s.lon };
  }

  map.on('popupopen', () => map.getContainer().classList.add('popup-open'));
  map.on('popupclose', () => setTimeout(() => { if (!map._popup || !map.hasLayer(map._popup)) map.getContainer().classList.remove('popup-open'); }, 0));

  // Tapped parcel: add a "Septic / sewer here" button to the map-tap popup
  map.on('popupopen', (e) => {
    const el = e.popup.getElement(), box = el && el.querySelector('.popup');
    if (!box || !box.querySelector('.search-here') || box.querySelector('.sep-tapbtn')) return;
    const ll = e.popup.getLatLng();
    const b = document.createElement('button'); b.className = 'small sep-tapbtn'; b.type = 'button'; b.textContent = '🚽 Septic / sewer here';
    box.appendChild(b);
    b.onclick = async (ev) => {
      ev.stopPropagation(); b.disabled = true; b.textContent = 'Looking up parcel…';
      const out = document.createElement('div'); out.className = 'sep-box';
      try {
        const p = await WS().lookupParcel(ll.lat, ll.lng);
        b.remove(); box.appendChild(out);
        if (!p.found) { out.innerHTML = '<div class="muted">No parcel at this point.</div>'; refreshPopup(); return; }
        const head = document.createElement('div'); head.className = 'sep-parcel';
        head.innerHTML = `Parcel <b>${esc(p.apn)}</b>${p.address ? ' · ' + esc(p.address) : ''}`;
        box.insertBefore(head, out);
        fillBox(out, { apn: p.apn, apns: [p.apn], parcel: p, address: p.address, lat: ll.lat, lon: ll.lng });
      } catch (err) { b.disabled = false; b.textContent = '🚽 Septic / sewer here (retry — offline?)'; }
      refreshPopup();
    };
  });

  // =====================================================================================================================
  // Map reference layers: sewer service areas + public sewer mains
  const KEY = 'wellsNearby.sewer';
  const ref = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } })();
  const refSave = () => { try { localStorage.setItem(KEY, JSON.stringify({ areas: !!ref.areas, mains: !!ref.mains })); } catch (e) { /* */ } };
  const areasLayer = L.layerGroup(), mainsLayer = L.layerGroup();
  let areasLoaded = null, mainsBox = null, mainsSeq = 0;
  const AREA_COLORS = ['#14b8a6', '#38bdf8'];
  function loadAreas() {
    if (areasLoaded) return areasLoaded;
    areasLoaded = Promise.all(SC.serviceAreas.map((s, i) => getJson(s.url, { where: s.where || '1=1', outFields: s.nameField, outSR: '4326', maxAllowableOffset: '0.00005', geometryPrecision: '5', f: 'geojson' }, 60000)
      .then((gj) => { L.geoJSON(gj, { interactive: false, style: { color: AREA_COLORS[i % 2], weight: 2, dashArray: '6 4', fillColor: AREA_COLORS[i % 2], fillOpacity: 0.12 } }).addTo(areasLayer); return (gj.features || []).length; })
      .catch(() => -1)));
    areasLoaded.then((n) => { if (n.every((x) => x < 0)) areasLoaded = null; renderCtl(); });
    return areasLoaded;
  }
  function mainLabel(m, p) {
    const size = p[m.size], mat = p[m.mat];
    return `${m.name}${size ? ` · ${size} in` : ''}${mat && mat !== 'XXX' ? ' · ' + mat : ''}`;
  }
  async function loadMains() {
    if (!ref.mains || map.getZoom() < SC.mainsMinZoom) { if (map.getZoom() < SC.mainsMinZoom) { mainsLayer.clearLayers(); mainsBox = null; } renderCtl(); return; }
    const vb = map.getBounds();
    if (mainsBox && mainsBox.contains(vb)) return;
    const bb = vb.pad(0.3), seq = ++mainsSeq;
    const env = [bb.getWest(), bb.getSouth(), bb.getEast(), bb.getNorth()].map((v) => v.toFixed(6)).join(',');
    const res = await Promise.all(SC.mains.map((m) => getJson(m.url, { geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: m.fields, outSR: '4326', geometryPrecision: '6', resultRecordCount: '2000', f: 'geojson' }).then((gj) => ({ m, gj })).catch(() => null)));
    if (seq !== mainsSeq) return;
    mainsLayer.clearLayers();
    let n = 0;
    for (const r of res) if (r) {
      n += (r.gj.features || []).length;
      L.geoJSON(r.gj, { bubblingMouseEvents: false, className: 'sewer-main', style: { color: '#84cc16', weight: 4, opacity: 0.95 },
        onEachFeature: (f, lyr) => lyr.bindPopup(`<div class="popup">${esc(mainLabel(r.m, f.properties || {}))}</div>`) }).addTo(mainsLayer);
    }
    mainsBox = res.some((r) => !r) ? null : bb;
    ctlState.mainsN = n; renderCtl();
  }
  const ctlState = { mainsN: null };
  const Ctl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const d = L.DomUtil.create('div', 'leaflet-bar sewer-ctl');
      d.innerHTML = `<button type="button" class="sw-btn" title="Sewer reference layers">🚽 Sewer</button>
        <div class="sw-panel"><label><input type="checkbox" class="sw-areas"> Service areas</label>
          <label><input type="checkbox" class="sw-mains"> Sewer mains</label><div class="sw-hint"></div></div>`;
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      return d;
    },
  });
  const ctl = new Ctl().addTo(map), cel = ctl.getContainer();
  let panelOpen = false;
  function renderCtl() {
    cel.classList.toggle('open', panelOpen); cel.classList.toggle('on', !!(ref.areas || ref.mains));
    cel.querySelector('.sw-areas').checked = !!ref.areas; cel.querySelector('.sw-mains').checked = !!ref.mains;
    const h = [];
    if (ref.areas) h.push('<i class="sw-sw a"></i>Ramona/Olivenhain/Borrego MWD <i class="sw-sw b"></i>County SD — being inside ≠ connected');
    if (ref.mains) h.push(map.getZoom() < SC.mainsMinZoom ? '<b class="warnc">Zoom in to see mains</b>' : `<i class="sw-sw m"></i>${ctlState.mainsN == null ? 'loading…' : ctlState.mainsN + ' pipes here'} (County SD + City of SD only)`);
    cel.querySelector('.sw-hint').innerHTML = h.join('<br>');
  }
  cel.querySelector('.sw-btn').onclick = () => { panelOpen = !panelOpen; renderCtl(); };
  cel.querySelector('.sw-areas').onchange = (e) => { ref.areas = e.target.checked; refSave(); applyRef(); };
  cel.querySelector('.sw-mains').onchange = (e) => { ref.mains = e.target.checked; refSave(); applyRef(); };
  function applyRef() {
    if (ref.areas) { if (!map.hasLayer(areasLayer)) areasLayer.addTo(map); loadAreas(); } else map.removeLayer(areasLayer);
    if (ref.mains) { if (!map.hasLayer(mainsLayer)) mainsLayer.addTo(map); ctlState.mainsN = null; mainsBox = null; loadMains(); } else { map.removeLayer(mainsLayer); mainsLayer.clearLayers(); mainsBox = null; }
    renderCtl();
  }
  let mvT = null;
  map.on('moveend zoomend', () => { clearTimeout(mvT); mvT = setTimeout(() => { if (ref.mains) loadMains(); renderCtl(); }, 400); });
  if (ref.areas || ref.mains) { panelOpen = true; applyRef(); } else renderCtl();

  // Public sewer mains close to a site (for the 50 ft sewer-line setback)
  async function mainsNear(site) {
    const res = await Promise.all(SC.mains.map((m) => getJson(m.url, { geometry: `${site.lon},${site.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      distance: String(SC.mainsCheckFt), units: 'esriSRUnit_Foot', outFields: m.fields, outSR: '4326', geometryPrecision: '7', f: 'geojson' }).then((gj) => ({ m, gj })).catch(() => ({ m, err: true }))));
    let best = null; const failed = res.filter((r) => r.err).length;
    for (const r of res) for (const f of (r.gj && r.gj.features) || []) {
      const g = f.geometry || {}, parts = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const part of parts) {
        const d = K.lineDist(site, part.map(([x, y]) => [y, x]));
        if (!best || d.ft < best.ft) best = { ft: d.ft, label: mainLabel(r.m, f.properties || {}) };
      }
    }
    return { best, failed, all: res.length };
  }

  // =====================================================================================================================
  // (c) setbacks: rings + tap-to-mark
  const sbLayer = L.layerGroup().addTo(map), hLayer = L.layerGroup().addTo(map);   // drawings / drag handles (kept during a drag)
  let cur = null;   // {site, tool, draft:[], editId, backup}
  const newId = () => 'mk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  function drawSetbacks(site, opts = {}) {
    sbLayer.clearLayers();
    if (!opts.skipHandles) hLayer.clearLayers();
    if (!site) return;
    const c = [site.lat, site.lon];
    for (const r of K.RINGS) {
      L.circle(c, { radius: r.ft * M_PER_FT, color: r.color, weight: 2.5, opacity: 0.95, fill: false, dashArray: r.ft === 150 ? null : '7 5', interactive: false }).addTo(sbLayer);
      const top = K.projector(site.lat, site.lon).inv(0, r.ft * M_PER_FT);
      L.marker(top, { interactive: false, keyboard: false, icon: L.divIcon({ className: '', html: `<div class="sb-ring-label" style="border-color:${r.color}">${r.ft} ft</div>`, iconSize: [44, 18], iconAnchor: [22, 9] }) }).addTo(sbLayer);
    }
    const marks = site.marks || [];
    for (const m of marks) {
      const r = K.evaluate(site, m); if (!r) continue;
      const kind = K.KINDS[m.kind], bad = r.status === 'inside', warn = r.status === 'near';
      const col = bad ? '#dc2626' : warn ? '#f59e0b' : kind.color;
      const editing = cur && cur.editId === m.id;
      const tip = `${kind.label} ${r.ftRounded} ft${bad ? ' ⚠' : ''}`;
      if (kind.geom === 'point') {
        L.circleMarker(m.pts[0], { radius: 10, color: '#fff', weight: 3, fillColor: col, fillOpacity: 1, interactive: false })
          .bindTooltip(tip, { permanent: true, direction: 'right', offset: [10, 0], className: 'sb-tip' + (bad ? ' bad' : '') }).addTo(sbLayer);
      } else {
        if (bad) L.polyline(m.pts, { color: '#fecaca', weight: 12, opacity: 0.8, interactive: false }).addTo(sbLayer);
        L.polyline(m.pts, { color: col, weight: 5, opacity: 1, dashArray: m.kind === 'tight' ? '10 7' : null, interactive: false })
          .bindTooltip(tip, { permanent: true, direction: 'center', className: 'sb-tip' + (bad ? ' bad' : '') }).addTo(sbLayer);
      }
      if (r.nearest && (bad || warn || editing || opts.showDist)) L.polyline([c, r.nearest], { color: col, weight: 2, dashArray: '3 5', interactive: false }).addTo(sbLayer);
      if (editing && !opts.skipHandles) m.pts.forEach((p, i) => {
        const h = L.marker(p, { draggable: true, zIndexOffset: 4000, icon: L.divIcon({ className: 'mark-handle', html: '<div></div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(hLayer);
        h.on('drag', () => { const ll = h.getLatLng(); m.pts[i] = [+ll.lat.toFixed(7), +ll.lng.toFixed(7)]; renderSheetList(); redrawSoon(); });
        h.on('dragend', () => { drawSetbacks(site); renderSheetList(); });
      });
    }
    if (cur && cur.draft && cur.draft.length) {
      const k = K.KINDS[cur.tool];
      if (cur.draft.length > 1) L.polyline(cur.draft, { color: k.color, weight: 4, dashArray: '4 6', interactive: false }).addTo(sbLayer);
      cur.draft.forEach((p) => L.circleMarker(p, { radius: 6, color: '#fff', weight: 2, fillColor: k.color, fillOpacity: 1, interactive: false }).addTo(sbLayer));
    }
  }
  let rdT = null;
  const redrawSoon = () => { if (rdT) return; rdT = requestAnimationFrame(() => { rdT = null; if (cur) drawSetbacks(cur.site, { skipHandles: true }); }); };

  function summaryHtml(site) {
    const ev = K.evaluateAll(site, site.marks);
    if (!ev.rows.length) return '';
    if (ev.inside.length) return `<div class="sb-sum bad">⚠ ${ev.inside.length} setback problem${ev.inside.length > 1 ? 's' : ''}: ${ev.inside.map((x) => `${esc(x.r.label)} ${x.r.ftRounded} ft (needs ${x.r.limitFt})`).join('; ')}</div>`;
    if (ev.near.length) return `<div class="sb-sum near">📏 ${ev.rows.length} marked — ${ev.near.length} just outside a setback; check with a tape</div>`;
    return `<div class="sb-sum ok">📏 ${ev.rows.length} marked — all clear of setbacks</div>`;
  }

  function openSetbacks(site) {
    const S = WS();
    map.closePopup();
    site.marks = site.marks || [];
    cur = { site, tool: null, draft: [], editId: null, backup: null };
    S.openSheet('setback', `<div class="sheet-head"><b>📏 Setbacks · ${esc(site.customer)}</b><button class="small" id="sbDone">Done</button></div>
      <div id="sbSummary"></div>
      <div class="sb-tools" id="sbTools">${Object.entries(K.KINDS).map(([k, v]) => `<button type="button" data-kind="${k}" class="sb-tool k-${k}"><span>${v.icon}</span>${v.label}<small>${v.setbackFt} ft</small></button>`).join('')}</div>
      <div id="sbInstr" class="sb-instr hidden"></div>
      <div id="sbList" class="sb-list"></div>
      <div id="sbMains" class="sb-mains muted">Checking mapped public sewer mains near the well…</div>
      <p class="muted small-note">Rings: <b style="color:#a855f7">50 ft</b> sewer / tight line · <b style="color:#f97316">100 ft</b> tank / leach line · <b style="color:#ef4444">150 ft</b> seepage pit.
        Mark from the septic layout drawing or what you see; distances are from the well pin. Tip: turn on ▦ Lines for property lines.</p>`);
    $('sheet').classList.add('compact');
    A.state.mapTool = true; $('map').classList.add('map-tool'); map.doubleClickZoom.disable();
    $('map').scrollIntoView({ behavior: 'auto', block: 'start' });
    map.setView([site.lat, site.lon], 19, { animate: false });
    $('sbDone').onclick = () => S.closeSheet();
    $('sbTools').querySelectorAll('button').forEach((b) => (b.onclick = () => startTool(b.dataset.kind)));
    renderSheet();
    const box = $('sbMains');
    mainsNear(site).then((r) => {
      if (!$('sbMains')) return;
      if (r.failed === r.all) { box.innerHTML = 'Could not check public sewer mains (offline?).'; return; }
      if (r.best) {
        const bad = r.best.ft < K.KINDS.sewer.setbackFt;
        box.className = 'sb-mains' + (bad ? ' bad' : '');
        box.innerHTML = `${bad ? '⚠' : 'ℹ️'} Mapped public sewer main <b>${Math.round(r.best.ft)} ft</b> from the well${bad ? ' — inside the 50 ft setback' : ''} (${esc(r.best.label)}).`;
      } else box.innerHTML = `No mapped public sewer main within ${SC.mainsCheckFt} ft. <small>(Mains are mapped only for County Sanitation District areas and the City of San Diego — not Ramona MWD, Padre Dam or other districts.)</small>`;
    });
  }
  function startTool(kind) {
    if (!cur) return;
    if (cur.editId) finishEdit(true);
    cur.tool = kind; cur.draft = [];
    renderSheet();
  }
  function renderSheet() {
    if (!cur || !$('sbSummary')) return;
    const site = cur.site;
    $('sbSummary').innerHTML = summaryHtml(site) || '<div class="sb-sum none">Nothing marked yet. Pick an item below, then tap the map where it is.</div>';
    $('sbTools').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.kind === cur.tool));
    const ins = $('sbInstr');
    if (cur.tool) {
      const k = K.KINDS[cur.tool];
      ins.classList.remove('hidden');
      ins.innerHTML = k.geom === 'point'
        ? `<b>Tap the map where the ${k.label.toLowerCase()} is.</b> <button class="small" id="sbCancel">Cancel</button>`
        : `<b>Tap each point along the ${k.label.toLowerCase()}</b> (${cur.draft.length} point${cur.draft.length === 1 ? '' : 's'}).
           <div class="sb-row"><button class="small" id="sbUndo" ${cur.draft.length ? '' : 'disabled'}>↶ Undo point</button>
           <button class="small good" id="sbFinish" ${cur.draft.length >= 2 ? '' : 'disabled'}>✓ Finish line</button><button class="small" id="sbCancel">Cancel</button></div>`;
      $('sbCancel').onclick = () => { cur.tool = null; cur.draft = []; renderSheet(); };
      if ($('sbUndo')) $('sbUndo').onclick = () => { cur.draft.pop(); renderSheet(); };
      if ($('sbFinish')) $('sbFinish').onclick = () => addMark(cur.tool, cur.draft.slice());
    } else { ins.classList.add('hidden'); ins.innerHTML = ''; }
    renderSheetList();
    drawSetbacks(site);
  }
  function renderSheetList() {
    if (!cur || !$('sbList')) return;
    const site = cur.site, rows = K.evaluateAll(site, site.marks).rows;
    $('sbList').innerHTML = rows.map(({ mark, r }) => `<div class="sb-item ${r.status}" data-id="${esc(mark.id)}">
        <div class="sb-text">${esc(K.warningText(r))}${mark.kind === 'leach' || mark.kind === 'sewer' || mark.kind === 'tight' ? ` <small class="muted">(${mark.pts.length} pts)</small>` : ''}</div>
        <div class="sb-row">${cur.editId === mark.id
          ? '<span class="muted">Drag the white handles.</span><button class="small good" data-act="save">✓ Done</button><button class="small" data-act="cancel">Cancel</button>'
          : '<button class="small" data-act="edit">✏️ Move</button><button class="small danger" data-act="del">🗑 Delete</button>'}</div></div>`).join('');
    $('sbList').querySelectorAll('.sb-item').forEach((it) => it.querySelectorAll('button').forEach((b) => (b.onclick = () => markAction(it.dataset.id, b.dataset.act))));
    $('sbSummary').innerHTML = summaryHtml(site) || '<div class="sb-sum none">Nothing marked yet. Pick an item below, then tap the map where it is.</div>';
  }
  async function saveSite() {
    const s = cur.site; s.updated = new Date().toISOString();
    try { await WS().Store.put(s); } catch (e) { WS().toast('Could not save on this device'); }
  }
  async function addMark(kind, pts) {
    const round = (p) => [+p[0].toFixed(7), +p[1].toFixed(7)];
    const m = { id: newId(), kind, pts: pts.map(round), created: new Date().toISOString() };
    cur.site.marks.push(m); cur.tool = null; cur.draft = [];
    await saveSite(); renderSheet();
    const r = K.evaluate(cur.site, m);
    WS().toast(r.status === 'inside' ? K.warningText(r) : `${r.label}: ${r.ftRounded} ft from the well`);
  }
  async function markAction(id, act) {
    const site = cur.site, m = site.marks.find((x) => x.id === id); if (!m) return;
    if (act === 'del') {
      if (!confirm(`Delete this ${K.KINDS[m.kind].label.toLowerCase()}?`)) return;
      site.marks = site.marks.filter((x) => x.id !== id); if (cur.editId === id) cur.editId = null;
      await saveSite(); renderSheet(); WS().toast('Mark deleted');
    } else if (act === 'edit') {
      if (cur.editId) finishEdit(true);
      cur.tool = null; cur.draft = []; cur.editId = id; cur.backup = JSON.parse(JSON.stringify(m.pts)); renderSheet();
    } else if (act === 'save') { await finishEdit(false); }
    else if (act === 'cancel') { finishEdit(true); }
  }
  async function finishEdit(cancel) {
    const m = cur.site.marks.find((x) => x.id === cur.editId);
    if (m && cancel && cur.backup) m.pts = cur.backup;
    cur.editId = null; cur.backup = null;
    if (m && !cancel) await saveSite();
    renderSheet();
  }
  map.on('click', (e) => {
    if (!cur || !cur.tool) { if (cur && A.state.mapTool) WS().toast('Pick what to mark first (tank, pit, leach line…)'); return; }
    const p = [e.latlng.lat, e.latlng.lng], k = K.KINDS[cur.tool];
    if (k.geom === 'point') addMark(cur.tool, [p]);
    else { cur.draft.push(p); renderSheet(); }
  });
  function onSheetClose() {
    if (!cur) { A.state.mapTool = false; $('map').classList.remove('map-tool'); map.doubleClickZoom.enable(); return; }
    if (cur.editId) finishEdit(true);
    cur = null; A.state.mapTool = false; $('map').classList.remove('map-tool'); map.doubleClickZoom.enable();
    $('sheet').classList.remove('compact');
    sbLayer.clearLayers(); hLayer.clearLayers();
  }
  // Show rings + marks while a site's popup is open (read-only)
  let popupSite = null;
  function showForSite(s) { if (!cur) { popupSite = s; drawSetbacks(s); } }
  map.on('popupclose', () => { if (!cur && popupSite) { popupSite = null; sbLayer.clearLayers(); hLayer.clearLayers(); } });

  // ---------- export helpers used by sites.js ----------
  function exportFields(s) {
    const ev = K.evaluateAll(s, s.marks), st = s.septic && s.septic.status && s.septic.status.own, rec = s.septic && s.septic.records;
    return {
      sewerStatus: st ? `${st.short}${st.level != null ? ` (level ${st.level})` : ''}` : '',
      septicRecords: rec ? String(rec.docs.length) : '',
      marks: ev.rows.map(({ mark, r }) => `${r.label} ${r.ftRounded} ft (needs ${r.limitFt})${r.status === 'inside' ? ' INSIDE' : r.status === 'near' ? ' close' : ''} [${mark.pts.map((p) => p[0].toFixed(6) + ' ' + p[1].toFixed(6)).join('; ')}]`).join(' | '),
      warnings: String(ev.inside.length),
    };
  }
  function kmlFor(s, x) {
    const rows = K.evaluateAll(s, s.marks).rows;
    const rings = K.RINGS.map((r) => `<Placemark><name>${r.ft} ft setback</name><styleUrl>#ring${r.ft}</styleUrl><LineString><tessellate>1</tessellate><coordinates>${K.circle(s, r.ft).map(([la, lo]) => `${lo.toFixed(7)},${la.toFixed(7)},0`).join(' ')}</coordinates></LineString></Placemark>`).join('');
    const marks = rows.map(({ mark, r }) => `<Placemark><name>${x(r.label)} — ${r.ftRounded} ft${r.status === 'inside' ? ' (INSIDE ' + r.limitFt + ' ft setback)' : ''}</name><description>${x(K.warningText(r))}</description><styleUrl>#mk-${r.status === 'inside' ? 'bad' : mark.kind}</styleUrl>${
      K.KINDS[mark.kind].geom === 'point' ? `<Point><coordinates>${mark.pts[0][1]},${mark.pts[0][0]},0</coordinates></Point>` : `<LineString><tessellate>1</tessellate><coordinates>${mark.pts.map((p) => `${p[1]},${p[0]},0`).join(' ')}</coordinates></LineString>`}</Placemark>`).join('');
    return `<Folder><name>${x(s.customer)} — setbacks &amp; septic marks</name>${rings}${marks}</Folder>`;
  }
  const kmlStyles = () => K.RINGS.map((r) => `<Style id="ring${r.ft}"><LineStyle><color>ff${r.color.slice(5, 7)}${r.color.slice(3, 5)}${r.color.slice(1, 3)}</color><width>2</width></LineStyle></Style>`).join('')
    + Object.entries(K.KINDS).map(([k, v]) => `<Style id="mk-${k}"><LineStyle><color>ff${v.color.slice(5, 7)}${v.color.slice(3, 5)}${v.color.slice(1, 3)}</color><width>4</width></LineStyle><IconStyle><color>ff${v.color.slice(5, 7)}${v.color.slice(3, 5)}${v.color.slice(1, 3)}</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>`).join('')
    + '<Style id="mk-bad"><LineStyle><color>ff2626dc</color><width>6</width></LineStyle><IconStyle><color>ff2626dc</color><scale>1.3</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>';

  window.WellsSeptic = { isActive: () => !!cur && !$('sheet').classList.contains('hidden'), fillBox, siteCtx, fillSite: (s, box) => fillBox(box, siteCtx(s)), fetchStatus, fetchRecords, openSetbacks, onSheetClose, showForSite,
    summaryHtml, exportFields, kmlFor, kmlStyles, mainsNear, drawSetbacks, get current() { return cur; }, applyRef, ref };
})();
