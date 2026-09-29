/* Wells Nearby — UI: geolocation, map, summary, table. */
(function () {
  'use strict';
  const C = window.WELLS_CONFIG, D = window.WellsData, S = window.WellsStats, M = window.WellsMatch, W = window.WellsDocs, CW = window.WellsCountyWcr;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));

  const state = {
    lat: null, lon: null, radius: C.defaultRadiusMiles, view: C.defaultView,
    stateRecs: [], countyRecs: [], shown: [], sort: { key: 'distanceMi', dir: 1 }, reqId: 0,
  };

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: true }).setView(C.defaultCenter, 11);
  const imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, maxNativeZoom: 19,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }).addTo(map);
  const labels = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
  ]).addTo(map);
  const streets = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' });
  const stateLayer = L.layerGroup().addTo(map);   // state WCRs (and merged state+county wells)
  const countyLayer = L.layerGroup().addTo(map);  // county permits
  const linkLayer = L.layerGroup();               // dashed lines: county parcel <-> state point for matched pairs (off by default)
  const meLayer = L.layerGroup().addTo(map);
  L.control.layers({ 'Satellite': imagery, 'Streets': streets }, {
    'Roads & labels': labels,
    '<span class="lg lg-state"></span> State wells (DWR)': stateLayer,
    '<span class="lg lg-county"></span> County permits (DEHQ)': countyLayer,
    'Duplicate links': linkLayer,
  }, { collapsed: true }).addTo(map);
  L.control.scale({ imperial: true, metric: false }).addTo(map);

  map.on('click', (e) => {
    if (state.mapTool) return;   // a map tool (e.g. septic marking in js/septic.js) owns taps
    const { lat, lng } = e.latlng;
    L.popup().setLatLng(e.latlng).setContent(
      `<div class="popup">${lat.toFixed(5)}, ${lng.toFixed(5)}<br><button class="small" id="searchHere">Search here</button></div>`).openOn(map);
    setTimeout(() => { const b = $('searchHere'); if (b) b.onclick = () => { map.closePopup(); setLocation(lat, lng, 'map tap'); }; }, 0);
  });

  // ---------- Controls ----------
  // Radius: slider 0–1 mi (0.05 steps) + quick buttons for wider searches. 0 = tapped point (searches minRadius internally).
  state.radiusUi = C.defaultRadiusMiles;
  const effRadius = (ui) => Math.max(ui, C.minRadiusMiles);
  function showRadius() {
    const ui = state.radiusUi;
    $('radiusVal').textContent = ui === 0 ? `0 mi (tapped point, ${C.minRadiusMiles} mi)` : `${+ui.toFixed(2)} mi`;
    $('radius').value = String(Math.min(ui, 1));
    document.querySelectorAll('#radiusWide button').forEach((b) => b.classList.toggle('on', +b.dataset.r === ui));
  }
  let radiusTimer = null;
  function setRadius(ui, go) {
    state.radiusUi = Math.max(0, Math.min(5, Math.round(ui * 100) / 100));
    showRadius();
    if (go && state.lat != null) { clearTimeout(radiusTimer); radiusTimer = setTimeout(() => { updateUrl(); search(); }, 150); }
  }
  $('radius').oninput = (e) => setRadius(+e.target.value, false);
  $('radius').onchange = (e) => setRadius(+e.target.value, true);
  document.querySelectorAll('#radiusWide button').forEach((b) => (b.onclick = () => setRadius(+b.dataset.r, true)));
  $('btnLocate').onclick = locate;
  $('btnSearch').onclick = () => {
    const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return setStatus('Enter a valid latitude and longitude (e.g. 33.0417, -116.8681).', true);
    setLocation(lat, lon, 'manual');
  };
  $('optAllUses').onchange = $('optDestroyed').onchange = () => applyFilters();
  $('btnCsv').onclick = downloadCsv;
  document.querySelectorAll('#viewSel button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

  function setView(v) {
    state.view = C.groups[v] ? v : 'both';
    document.querySelectorAll('#viewSel button').forEach((b) => b.classList.toggle('on', b.dataset.view === state.view));
    // Map layers follow the selector (user can still toggle them in the layer control).
    if (state.view === 'county') { map.removeLayer(stateLayer); map.addLayer(countyLayer); }
    else if (state.view === 'state') { map.addLayer(stateLayer); map.removeLayer(countyLayer); }
    else { map.addLayer(stateLayer); map.addLayer(countyLayer); }
    updateUrl();
    applyFilters();
  }

  function setStatus(msg, err) { const s = $('status'); s.innerHTML = msg; s.classList.toggle('err', !!err); }

  function locate() {
    if (!('geolocation' in navigator)) return setStatus('Geolocation not available — enter coordinates manually.', true);
    setStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      (p) => setLocation(p.coords.latitude, p.coords.longitude, `GPS ±${Math.round(p.coords.accuracy * 3.281)} ft`),
      (e) => setStatus(`Location unavailable (${esc(e.message || 'denied')}). Enter lat/lon manually or tap the map.`, true),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  function updateUrl() {
    if (state.lat == null) return;
    const u = new URL(location.href);
    u.searchParams.set('lat', state.lat.toFixed(5)); u.searchParams.set('lon', state.lon.toFixed(5));
    u.searchParams.set('r', String(state.radiusUi)); u.searchParams.set('view', state.view);
    history.replaceState(null, '', u);
  }

  function setLocation(lat, lon, how) {
    state.lat = lat; state.lon = lon; state.how = how;
    $('lat').value = lat.toFixed(5); $('lon').value = lon.toFixed(5);
    updateUrl();
    search();
  }

  async function search() {
    state.radius = effRadius(state.radiusUi);
    const { lat, lon, radius } = state, id = ++state.reqId;
    drawMe();
    setStatus(`Searching ${radius} mi around ${lat.toFixed(5)}, ${lon.toFixed(5)}…`);
    const t0 = performance.now();
    // Fetch a buffer beyond the radius so duplicates straddling the edge still pair up; views are cut back to the radius.
    // At 0 mi ("just this point") fetch a bit wider so the nearest wells can be shown if none are within 0.05 mi.
    const qr = Math.max(radius, state.radiusUi === 0 ? C.nearestFetchMiles : 0) + C.matching.bufferMiles;
    // county WCR shards for the same circle load in parallel with the well queries
    const [res] = await Promise.all([D.queryAll(lat, lon, qr), CW.ensure(lat, lon, qr)]);
    if (id !== state.reqId) return; // a newer search started
    state.stateRecs = res.state.records; state.countyRecs = res.county.records;
    // well permits newer than the county GIS layer (Aug 2020) that the extractor found in the DEH library
    state.countyRecs.push(...CW.libraryRecords(lat, lon, qr, new Set(state.countyRecs.map((c) => c.permit && c.permit.toUpperCase()))));
    M.findMatches(state.stateRecs, state.countyRecs);
    CW.apply(state.stateRecs, state.countyRecs, { lat, lon });
    const inR = (w) => w.distanceMi <= radius;
    const parts = [];
    parts.push(res.state.error ? `<span class="bad">State data failed: ${esc(res.state.error)}</span>`
      : `State: ${state.stateRecs.filter(inR).length} records${res.state.errors && res.state.errors.length ? ' (fallback source)' : ''}`);
    parts.push(res.county.error ? `<span class="bad">County data failed: ${esc(res.county.error)}</span>`
      : `County: ${state.countyRecs.filter(inR).length} permits`);
    if (res.state.truncated || res.county.truncated) parts.push('<b>RESULT TRUNCATED — reduce radius</b>');
    parts.push(`${Math.round(performance.now() - t0)} ms`);
    setStatus(parts.join(' · '), !!(res.state.error && res.county.error));
    applyFilters();
    parcelHere(lat, lon, id);
  }

  // ------------------------------------------------ the parcel at the search point: its well permits + septic
  // The county GIS permit layer ends in Aug 2020 and its points are parcel centres, so a newer well on this parcel only
  // exists in the DEH document library, filed by APN (exact format XXX-XXX-XX-XX). Several wells per APN are kept.
  /** A point inside the parcel (rings of [lat, lon]): area centroid of the largest ring, or for L/U shapes the middle
   *  of the longest inside stretch of the horizontal line through it (same rule as tools/extract_county_wcr.py). */
  function insidePoint(rings, lat, lon) {
    if (!rings || !rings.length) return [lat, lon];
    const edges = (r) => r.map((a, i) => [a, r[(i + 1) % r.length]]);
    const ac = (r) => { let a = 0, cx = 0, cy = 0; for (const [[y1, x1], [y2, x2]] of edges(r)) { const k = x1 * y2 - x2 * y1; a += k; cx += (x1 + x2) * k; cy += (y1 + y2) * k; }
      return a ? [a / 2, cx / (3 * a), cy / (3 * a)] : [0, r[0][1], r[0][0]]; };
    const big = rings.reduce((m, r) => (Math.abs(ac(r)[0]) > Math.abs(ac(m)[0]) ? r : m), rings[0]);
    let [, x, y] = ac(big);
    const xs = []; for (const r of rings) for (const [[y1, x1], [y2, x2]] of edges(r)) if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
    xs.sort((a, b) => a - b);
    let inside = false; for (const v of xs) if (x < v) inside = !inside;
    if (!inside) { let best = null; for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]]; if (best) x = (best[0] + best[1]) / 2; else return [lat, lon]; }
    return [+y.toFixed(6), +x.toFixed(6)];
  }

  async function parcelHere(lat, lon, id) {
    const el = $('parcelCard');
    if (!el || !window.WellsSites) return;
    el.classList.add('hidden'); el.innerHTML = '';
    let p;
    try { p = await WellsSites.lookupParcel(lat, lon); } catch (e) { return; }
    if (id !== state.reqId || !p || !p.found || !p.apn) return;
    const apn = W.apnFull(p.apn) || p.apn;
    let docs = [], libErr = null;
    try { docs = await W.searchRaw({ parcel_number: apn }); } catch (e) { libErr = e.message || 'failed'; }
    if (id !== state.reqId) return;
    const [cLat, cLon] = insidePoint(p.rings, lat, lon);
    const known = new Map(state.countyRecs.filter((c) => c.permit).map((c) => [c.permit.toUpperCase(), c]));
    const byPermit = new Map();
    for (const d of docs) { const pid = String(d.permit_id || '').trim().toUpperCase(); if (/-LWELL-/.test(pid)) (byPermit.get(pid) || byPermit.set(pid, []).get(pid)).push(d); }
    const added = [];
    for (const [pid, ds] of byPermit) {
      if (known.has(pid)) continue;
      const first = ds.map((d) => (d.r_creation_date || '').slice(0, 10)).filter(Boolean).sort()[0];
      const w = CW.libRecord(pid, cLat, cLon, apn, first, { lat, lon });
      state.countyRecs.push(w); known.set(pid, w); added.push(pid);
    }
    // layer permits filed on this APN too (GIS Parcel_No is XXX-XXX-XX-XX)
    const onApn = state.countyRecs.filter((c) => c.permit && W.apnFull(c.apn) === apn).map((c) => c.permit.toUpperCase());
    const wells = [...new Set([...byPermit.keys(), ...onApn])].sort();
    if (added.length) { M.findMatches(state.stateRecs, state.countyRecs); CW.apply(state.stateRecs, state.countyRecs, { lat, lon }); applyFilters(); }
    const wellLine = (pid) => { const c = known.get(pid), e = CW.index && CW.index[pid];
      const tag = c && c.libraryOnly ? ' <small class="muted">library only</small>' : '';
      const st = e ? ` · <small>${esc(CW.STATUS_TEXT[e.status] || e.status)}</small>` : ' · <small class="muted">WCR not processed yet</small>';
      const n = (byPermit.get(pid) || []).length;
      return `<li><b>${esc(pid)}</b>${tag}${st}${n ? ` · <small>${n} doc${n > 1 ? 's' : ''}</small>` : ''}</li>`; };
    el.innerHTML = `<div class="sub">🏠 This parcel: APN ${esc(apn)}${p.acreage ? ` · ${esc(p.acreage)} ac` : ''}${p.address ? ` · ${esc(p.address)}` : ''}</div>
      <div><b>Well permits on this APN:</b> ${wells.length ? `<ul class="doclist">${wells.map(wellLine).join('')}</ul>` : '<span class="muted">none found</span>'}
      ${libErr ? `<div class="bad small">Document library search failed (${esc(libErr)})</div>` : ''}
      ${added.length ? `<div class="muted small">${added.length} permit${added.length > 1 ? 's are' : ' is'} newer than the county GIS layer (ends Aug 2020); added from the DEH library at the parcel centre.</div>` : ''}</div>
      <div class="sep-box"></div>`;
    el.classList.remove('hidden');
    if (window.WellsSeptic) WellsSeptic.fillBox(el.querySelector('.sep-box'), { apn, apns: [apn], parcel: p, address: p.address || '', lat, lon });
  }

  function applyFilters() {
    if (state.lat == null) return;
    const allUses = $('optAllUses').checked, destroyed = $('optDestroyed').checked;
    const view = M.buildView(state.view, state.stateRecs, state.countyRecs, state.radius);
    const keep = (w) => (allUses || w.waterSupply) && (destroyed || !w.destruction);
    state.shown = view.filter(keep);
    state.nearestMode = false;
    if (!state.shown.length && state.radiusUi === 0) {
      // 0 mi and nothing within 0.05 mi: show the nearest wells to the tapped point instead of an empty result.
      const wide = M.buildView(state.view, state.stateRecs, state.countyRecs, C.nearestFetchMiles).filter(keep).filter((w) => w.distanceMi != null)
        .sort((a, b) => a.distanceMi - b.distanceMi);
      if (wide.length) {
        const d0 = wide[0].distanceMi;
        state.shown = wide.filter((w, i) => i < C.nearestCount || w.distanceMi <= d0 + 0.01);
        state.nearestMode = true;
      }
    }
    state.shown.forEach((w) => { const q = W.docQueries(w); w.docHint = q.some((x) => !x.secondary) ? '📄' : q.length ? 'APN' : ''; });
    renderSummary(); renderMarkers(); renderTable();
    if (state.nearestMode) {
      const pts = state.shown.filter((w) => w.lat != null).map((w) => [w.lat, w.lon]).concat([[state.lat, state.lon]]);
      map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 17 });
    }
  }

  // ---------- Map drawing ----------
  function drawMe() {
    meLayer.clearLayers();
    const ll = [state.lat, state.lon];
    L.circle(ll, { radius: state.radius * 1609.344, color: '#38bdf8', weight: 2, fillOpacity: 0.05, interactive: false }).addTo(meLayer);
    L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 })
      .bindPopup(`<div class="popup"><h3>Your location</h3>${state.lat.toFixed(6)}, ${state.lon.toFixed(6)}<br>${esc(state.how || '')}</div>`).addTo(meLayer);
    map.fitBounds(L.latLng(ll).toBounds(Math.max(state.radius, 0.2) * 1609.344 * 2.1));
  }

  function pinIcon(ws) {
    const counts = {}; ws.forEach((w) => (counts[w.methodKey] = (counts[w.methodKey] || 0) + 1));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const color = C.methodCategories.find((c) => c.key === top).color;
    const size = ws.length > 1 ? Math.min(34, 20 + Math.log2(ws.length) * 3) : 16;
    const g = ws[0].group; // state | county | both
    const label = ws.length > 1 ? ws.length : '';
    const nRed = ws.filter((w) => w.wcrFlag === 'read').length, nPend = ws.filter((w) => w.wcrFlag === 'pending').length;
    // Fluorescent red = at least one report here must be read by hand (all red if every record needs it).
    const cls = nRed === ws.length ? ' pin-red' : nRed ? ' pin-somered' : nPend === ws.length ? ' pin-pending' : '';
    const bg = nRed === ws.length ? C.countyWcr.needsReadColor : color;
    return L.divIcon({ className: '', html: `<div class="well-pin pin-${g}${cls}" style="width:${size}px;height:${size}px;background:${bg}">${label}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function renderMarkers() {
    stateLayer.clearLayers(); countyLayer.clearLayers(); linkLayer.clearLayers();
    // Many WCRs share the same (section-centroid) coordinates: group them into one marker per source group.
    const groups = new Map();
    for (const w of state.shown) {
      if (w.lat == null) continue;
      const k = w.group + '|' + w.lat.toFixed(5) + ',' + w.lon.toFixed(5);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(w);
    }
    for (const ws of groups.values()) {
      const red = ws.some((w) => w.wcrFlag === 'read');
      const m = L.marker([ws[0].lat, ws[0].lon], { icon: pinIcon(ws), zIndexOffset: red ? 500 : ws[0].group === 'county' ? 0 : 100 })
        .bindPopup(() => groupPopup(ws), { maxWidth: 310, maxHeight: 300 });
      m.addTo(ws[0].group === 'county' ? countyLayer : stateLayer);
      ws.forEach((w) => (w._marker = m));
    }
    // Dashed links between matched pairs (county parcel <-> state point).
    const seen = new Set();
    for (const w of state.shown) {
      const pair = w.group === 'both' ? [[w.county.lat, w.county.lon], w.statePoint]
        : w.group === 'state' && w.match ? [[w.lat, w.lon], [w.match.county.lat, w.match.county.lon]]
        : w.group === 'county' && w.matches && w.matches.length ? [[w.lat, w.lon], [w.matches[0].state.lat, w.matches[0].state.lon]] : null;
      if (!pair) continue;
      const k = pair.flat().join(',');
      if (seen.has(k)) continue; seen.add(k);
      L.polyline(pair, { color: '#e0f2fe', weight: 1.5, dashArray: '4 4', opacity: 0.9, interactive: false }).addTo(linkLayer);
    }
  }

  const row = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;

  function countyRows(c) {
    return [
      row('Permit', `<b>${esc(c.permit)}</b>`),
      row('Opened', c.openedStr || c.dateStr),
      row('Work', esc(c.recordType || '—') + (c.status ? ` <small>(${esc(c.status)})</small>` : '')),
      row('Use', esc(c.wellUse || '—')),
      row('Address', esc(c.address || '—')),
      row('APN', esc(c.apn || '—')),
    ].join('');
  }

  function wellDetails(w) {
    const g = C.groups[w.group];
    const src = `<div class="srcTag src-${w.group}">${esc(g.label)}</div>`;
    const tag = (k) => { const f = w.fieldSrc && w.fieldSrc[k]; return f && f.src === 'ocr' ? ` <span class="ocrTag" title="read by OCR from the county completion report">county WCR (OCR, ${esc(f.conf)})</span>` : ''; };
    const rowsLog = [
      row('Depth', (w.depthFt != null ? fmt(w.depthFt) + ' ft' : '—') + tag('depthFt')),
      row('Method', `${w.methodLabel} <small>(${esc(w.methodDetail)})</small>`),
      row('Yield', (w.gpm != null ? fmt(w.gpm, 1) + ' GPM' : (w.yieldZero ? '0 (dry?)' : '—')) + tag('gpm')),
      row('SWL', (w.swlFt != null ? fmt(w.swlFt) + ' ft' : '—') + tag('swlFt')),
    ];
    if (w.fieldSrc && w.fieldSrc.date && w.fieldSrc.date.src === 'ocr') rowsLog.push(row('Drilled', esc(w.dateStr) + tag('date')));
    if (w.group === 'county') {
      const mt = w.matches.length ? `<div class="dup">${esc(w.matchLabel)} same well as state ${esc(w.wcr)} — ${esc(w.matches[0].reason)}. Log values below are from that WCR.</div>` : '<div class="dup none">No matching state WCR found — permit record only.</div>';
      const pdf = w.pdfUrl ? ` · <a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">WCR PDF</a>` : '';
      const hasLog = w.matches.length || w.depthFt != null || w.gpm != null || w.swlFt != null || w.methodKey !== 'nolog';
      return `${src}<b>${esc(w.permit)}</b>${pdf}${wcrBlock(w)}${mt}<table>${countyRows(w)}${hasLog ? rowsLog.join('') : ''}${row('Distance', fmt(w.distanceMi, 2) + ' mi')}${row('Loc. accuracy', esc(w.llAccuracy))}</table>${docsBlock(w)}`;
    }
    const rows = rowsLog.concat([
      row('Date', w.dateStr),
      row('Use', esc(w.plannedUse || w.b118Use || '—')),
      row('Record', esc(w.recordType || '—')),
      row('Casing Ø', esc(w.casingDiameter || '—')),
      row('Perfs', w.perfTop || w.perfBottom ? `${esc(w.perfTop || '?')}–${esc(w.perfBottom || '?')} ft` : '—'),
      row('Driller', esc(w.driller || '—')),
      row('Distance', w.distanceMi != null ? fmt(w.distanceMi, 2) + ' mi' : '—'),
      row('Loc. accuracy', esc(w.llAccuracy || 'not recorded')),
    ]);
    const pdf = w.pdfUrl ? ` · <a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">WCR PDF</a>` : '';
    const c = w.group === 'both' ? w.county : (w.match && w.match.county);
    const dup = c ? `<div class="dup">${esc(w.matchLabel)} duplicate of county permit ${esc(c.permit)} — ${esc(w.match.reason)}</div>` : '';
    const ctab = c ? `<div class="sub">County permit</div><table>${countyRows(c)}</table>` : '';
    return `${src}<b>${esc(w.wcr || w.legacyLog || 'WCR ?')}</b>${pdf}${c ? wcrBlock(w) : ''}${dup}<table>${rows.join('')}</table>${ctab}${docsBlock(w)}`;
  }

  // County completion-report status: red call-to-action when the report must be read by hand.
  const OCR_COL = { depthFt: 'depthFt', gpm: 'gpm', swlFt: 'swlFt', methodLabel: 'method', dateStr: 'date' };
  function ocrMark(w, key) {
    const f = OCR_COL[key] && w.fieldSrc && w.fieldSrc[OCR_COL[key]];
    return f && f.src === 'ocr' ? `<sup class="ocrmk" title="from county WCR (OCR), ${esc(f.conf)} confidence">OCR</sup>` : '';
  }
  function wcrBlock(w) {
    const st = w.wcrStatus || 'not_processed';
    const text = CW.STATUS_TEXT[st] || st;
    const url = w.wcrDocUrl;
    const checks = (w.ocrCheck || []).map((k) => `${k.field.replace('Ft', '').replace('gpm', 'GPM')}: OCR ${fmt(k.ocr)} vs state ${fmt(k.state)} ${k.ok ? '✓' : '✗'}`).join(' · ');
    if (w.wcrFlag === 'read') {
      const partialState = w.group !== 'county' && (w.gpm != null || w.swlFt != null) ? '<br><small>State record has no depth (other values shown are from the state).</small>' : '';
      const pg = w.wcrEntry && w.wcrEntry.bestDocPage ? ` (page ${w.wcrEntry.bestDocPage})` : '';
      const h = CW.hints(w.wcrEntry);
      const cs = (w.county || w).status || '';
      const expired = st === 'no_wcr' && /expir|cancel|void|withdr/i.test(cs) ? `<br><small>Permit status "${esc(cs)}" — the well may never have been drilled.</small>` : '';
      const hint = h.length ? `<br><small>Partly legible, unverified: ${esc(h.join(', '))}</small>` : '';
      return `<div class="needread"><b>Read this report yourself</b><br>${esc(text)}.${partialState}${hint}${expired}<br>${url
        ? `<a class="readbtn" href="${esc(url)}" target="_blank" rel="noopener">📋 Open ${st === 'unreadable' || st === 'partial' ? 'completion report' + pg : 'permit documents'} ↗</a>`
        : 'See the document list below.'}</div>`;
    }
    if (w.wcrFlag === 'pending') {
      return `<div class="wcrinfo pending">County WCR: ${esc(text)}. ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open document ↗</a>` : 'Documents are listed below.'}</div>`;
    }
    if (st === 'not_processed') return '';
    return `<div class="wcrinfo">County WCR: ${esc(text)}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">open report ↗</a>` : ''}${checks ? `<br><small>Check vs state: ${esc(checks)}</small>` : ''}</div>`;
  }

  // ---------- County document library (fetched when the popup opens) ----------
  const docReqs = new Map(); let docSeq = 0;
  function docsBlock(w) {
    const qs = W.docQueries(w);
    if (!qs.length) return '';
    const id = 'docs' + (++docSeq);
    docReqs.set(id, qs);
    if (docReqs.size > 200) docReqs.delete(docReqs.keys().next().value);
    return `<div class="docs" id="${id}"><div class="sub">County documents (DEHQ library)</div><div class="docs-body"><span class="muted">…</span></div></div>`;
  }
  function libLink(q) {
    return `<a href="${esc(C.docLibrary.searchPage)}" target="_blank" rel="noopener">Open library search ↗</a> <span class="muted">(enter ${q.type === 'record_id' ? 'Record ID' : 'APN'} <b class="copy" data-copy="${esc(q.value)}" title="tap to copy">${esc(q.value)}</b>)</span>`;
  }
  function renderDocList(docs, q, filtered) {
    if (!docs.length) return `<div class="muted">No documents found for ${esc(q.label)}${q.guessed ? ' (permit ID derived from the WCR)' : ''}.</div>`;
    return `<div class="muted">${docs.length} document${docs.length > 1 ? 's' : ''} for ${esc(q.label)}${filtered ? ' (well-related)' : ''}${q.guessed ? ' — permit ID derived from WCR' : ''}:</div><ul class="doclist">${docs.map((d) =>
      `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${d.isWcr ? '📋 Well Completion Report' : '📄 ' + esc(d.description && !/^approved$/i.test(d.description) ? d.description : (/^approved$/i.test(d.description) ? 'Approved permit' : d.subtype))}</a>${d.isWcr ? ' <span class="dupTag">driller log</span>' : ''}${d.permit && q.type !== 'record_id' ? ` <small>${esc(d.permit)}</small>` : ''} <small class="muted">scanned ${esc(d.scanned)} · ${d.sizeKb} KB</small></li>`).join('')}</ul>`;
  }
  async function runDocQuery(el, q) {
    const body = el.querySelector('.docs-body');
    body.innerHTML = `<span class="muted">Searching county library for ${esc(q.label)}…</span>`;
    try {
      let docs = await W.search(q.type, q.value);
      let filtered = false;
      if (q.type === 'parcel_number') {
        const well = docs.filter((d) => C.docLibrary.wellSubtypes.includes('DEH-LWQD-' + d.subtype));
        filtered = well.length < docs.length; docs = well;
      }
      return renderDocList(docs, q, filtered);
    } catch (e) {
      return `<div class="bad">Library lookup failed (${esc(e.message || e)}).</div>`;
    }
  }
  async function loadDocs(root) {
    for (const el of root.querySelectorAll('.docs')) {
      if (el.dataset.loaded) continue; el.dataset.loaded = '1';
      const qs = docReqs.get(el.id) || [];
      const main = qs.find((q) => !q.secondary) || qs[0];
      const apn = qs.find((q) => q.secondary && q !== main);
      const body = el.querySelector('.docs-body');
      let html = await runDocQuery(el, main);
      if (apn) html += `<button class="small" data-apn="1">Also search parcel ${esc(apn.value)}</button><div class="apn-res"></div>`;
      html += `<div class="liblink">${libLink(main)}</div>`;
      body.innerHTML = html;
      const b = body.querySelector('button[data-apn]');
      if (b) b.onclick = async (ev) => {
        ev.stopPropagation(); b.disabled = true;
        const tmp = document.createElement('div'); tmp.innerHTML = '<div class="docs-body"></div>';
        const res = await runDocQuery(tmp, apn);
        body.querySelector('.apn-res').innerHTML = res; b.remove();
      };
      body.querySelectorAll('.copy').forEach((c) => (c.onclick = (ev) => { ev.stopPropagation(); navigator.clipboard && navigator.clipboard.writeText(c.dataset.copy); c.classList.add('copied'); }));
    }
  }
  map.on('popupopen', (e) => loadDocs(e.popup.getElement()));

  function groupPopup(ws) {
    if (ws.length === 1) return `<div class="popup">${wellDetails(ws[0])}</div>`;
    setTimeout(() => document.querySelectorAll('.leaflet-popup .item .open-item').forEach((a) => (a.onclick = (ev) => {
      ev.preventDefault();
      const w = ws[+a.closest('.item').dataset.i];
      if (w && w._marker) L.popup({ maxWidth: 310, maxHeight: 300 }).setLatLng(w._marker.getLatLng()).setContent(`<div class="popup">${wellDetails(w)}</div>`).openOn(map);
    })), 0);
    const acc = ws[0].llAccuracy ? ` — ${esc(ws[0].llAccuracy)}` : '';
    const sorted = [...ws].sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
    const g = C.groups[ws[0].group];
    return `<div class="popup"><div class="srcTag src-${ws[0].group}">${esc(g.label)}</div><h3>${ws.length} records at this point${acc}</h3><div class="list">${sorted.map((w) =>
      `<div class="item" data-i="${ws.indexOf(w)}"><a href="#" class="open-item"><b>${esc(w.wcr || w.permit || '?')}</b></a>${w.matchLabel ? ` <span class="dupTag">dup: ${esc(w.matchLabel)}</span>` : ''} · ${w.depthFt != null ? fmt(w.depthFt) + ' ft' : '— ft'} · ${w.gpm != null ? fmt(w.gpm, 1) + ' gpm' : '— gpm'} · SWL ${w.swlFt != null ? fmt(w.swlFt) : '—'} · ${esc(w.methodLabel)} · ${w.dateStr}${w.pdfUrl ? ` · <a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">PDF</a>` : ''}</div>`).join('')}</div></div>`;
  }

  // ---------- Summary ----------
  function renderSummary() {
    const s = S.summarize(state.shown);
    const el = $('summary'); el.classList.remove('hidden');
    const stat = (k, v, d) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const methods = s.methods.filter((m) => m.count);
    const noteStacked = s.uniqueLocations < s.total ? `${s.total} records at ${s.uniqueLocations} distinct map points. ` : '';
    const nRed = state.shown.filter((w) => w.wcrFlag === 'read').length;
    const nPend = state.shown.filter((w) => w.wcrFlag === 'pending').length;
    const nOcr = state.shown.filter((w) => w.fieldSrc && Object.values(w.fieldSrc).some((f) => f.src === 'ocr')).length;
    const wcrNote = (nOcr || nRed || nPend) ? `<div class="wcrsum">${nOcr ? `<span class="ocrTag">${nOcr} with values from county WCR (OCR)</span> ` : ''}${nRed ? `<span class="redTag">${nRed} to read yourself</span> ` : ''}${nPend ? `<span class="pendTag">${nPend} not yet processed</span>` : ''}</div>` : '';
    let nearest = '';
    if (s.total === 0) {
      const allUses = $('optAllUses').checked, destroyed = $('optDestroyed').checked;
      const cand = M.buildView(state.view, state.stateRecs, state.countyRecs, 1e9).filter((w) => (allUses || w.waterSupply) && (destroyed || !w.destruction) && w.distanceMi != null).sort((a, b) => a.distanceMi - b.distanceMi);
      if (cand.length) nearest = ` Nearest record: ${esc(cand[0].wcr || cand[0].permit || '')} at ${fmt(cand[0].distanceMi, 2)} mi — widen the radius.`;
    }
    const nCounty = state.shown.filter((w) => w.group === 'county').length;
    const nNoLog = state.shown.filter((w) => w.methodKey === 'nolog').length;
    const nDup = state.shown.filter((w) => w.matchLabel).length;
    const viewNote = {
      state: `State WCRs only. ${nDup} have a likely/possible county-permit duplicate.`,
      county: `County permits only (unincorporated area, permits opened through 2020). Depth/yield/SWL/method come from the matched state WCR; ${nNoLog} of ${nCounty} permits have no match (no log data). Year = permit date.`,
      both: `State WCRs + county permits with duplicates merged (${nDup} merged pairs, drawn at the county parcel point). ${nNoLog} county permits have no WCR match (no log data). Year = drilled date, or permit date for county-only.`,
    }[state.view];
    el.innerHTML = `
      <h2>${esc(C.groups[state.view].label)} · ${state.nearestMode ? `nearest to this point (none within ${state.radius} mi)` : `within ${state.radius} mi`} · ${s.total} wells</h2>
      ${s.total === 0 ? `<p>No matching wells within ${state.radius} mi.${nearest || ' Try a larger radius, another data view, or include all uses.'}</p>` : `${wcrNote}
      <div class="stats">
        ${stat('Avg depth', fmt(s.depth.avg) + ' <small>ft</small>', `min ${fmt(s.depth.min)} · max ${fmt(s.depth.max)} · median ${fmt(s.depth.median)} · n=${s.depth.n}`)}
        ${stat('Avg yield', fmt(s.gpm.avg, 1) + ' <small>GPM</small>', `median ${fmt(s.gpm.median, 1)} · range ${fmt(s.gpm.min, 1)}–${fmt(s.gpm.max)} · n=${s.gpm.n}${s.yieldZeroCount ? ` · ${s.yieldZeroCount} reported 0` : ''}`)}
        ${stat('Avg static water level', fmt(s.swl.avg) + ' <small>ft bgs</small>', `median ${fmt(s.swl.median)} · range ${fmt(s.swl.min)}–${fmt(s.swl.max)} · n=${s.swl.n}`)}
        ${stat('Year', s.year.n ? `${s.year.min}–${s.year.max}` : '—', `median ${s.year.median != null ? Math.round(s.year.median) : '—'} · n=${s.year.n}`)}
      </div>
      <div class="methods">
        <div class="k" style="font-size:12px;color:#64748b;margin-bottom:4px">DRILLING METHOD</div>
        <div class="bar">${methods.map((m) => `<span title="${m.label}" style="width:${m.pct}%;background:${m.color}"></span>`).join('')}</div>
        <div class="legend">${methods.map((m) => `<span><i style="background:${m.color}"></i>${m.label}: <b>${m.count}</b> (${m.pct.toFixed(0)}%)</span>`).join('')}</div>
      </div>
      <div class="meta">${esc(viewNote)} ${noteStacked}Location accuracy: ${s.accuracy.map(([k, v]) => `${esc(k)} ${v}`).join(', ')}.</div>`}`;
  }

  // ---------- Table ----------
  function renderTable() {
    $('tableCard').classList.toggle('hidden', state.shown.length === 0);
    $('wellCount').textContent = `(${state.shown.length})`;
    const cols = C.tableColumns, { key, dir } = state.sort;
    const col = cols.find((c) => c.key === key) || cols[0];
    const sk = col.sortKey || col.key;
    const rows = [...state.shown].sort((a, b) => {
      const x = a[sk], y = b[sk];
      if ((x == null || x === '') && (y == null || y === '')) return 0; if (x == null || x === '') return 1; if (y == null || y === '') return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    const t = $('wellTable');
    t.innerHTML = `<thead><tr>${cols.map((c) => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}">${c.label}${c.key === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((w, i) => `<tr data-i="${i}" class="row-${w.group}${w.wcrFlag === 'read' ? ' row-red' : w.wcrFlag === 'pending' ? ' row-pending' : ''}">${cols.map((c) => `<td class="${c.num ? 'num' : ''} col-${c.key}">${esc(c.fmt ? c.fmt(w[c.key]) : (w[c.key] || '—'))}${ocrMark(w, c.key)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    t.querySelectorAll('th').forEach((th) => (th.onclick = () => {
      const k = th.dataset.k; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; renderTable();
    }));
    t.querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => {
      const w = rows[+tr.dataset.i];
      t.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel')); tr.classList.add('sel');
      if (w._marker) {
        L.popup({ maxWidth: 310, maxHeight: 300 }).setLatLng(w._marker.getLatLng()).setContent(`<div class="popup">${wellDetails(w)}</div>`).openOn(map);
        document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }));
  }

  function downloadCsv() {
    const f = ['srcShort', 'wcr', 'permitId', 'matchLabel', 'distanceMi', 'lat', 'lon', 'llAccuracy', 'depthFt', 'methodLabel', 'method', 'fluid', 'gpm', 'swlFt', 'dateStr', 'plannedUse', 'recordType', 'apn', 'address', 'casingDiameter', 'driller', 'pdfUrl'];
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const csv = [f.join(',')].concat(state.shown.map((w) => f.map((k) => q(k === 'distanceMi' && w[k] != null ? w[k].toFixed(3) : w[k])).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `wells_${state.view}_${state.lat.toFixed(4)}_${state.lon.toFixed(4)}_${state.radius}mi.csv`;
    a.click();
  }

  // ---------- Startup ----------
  const qp = new URLSearchParams(location.search);
  const qr = parseFloat(qp.get('r'));
  setRadius(Number.isFinite(qr) ? qr : C.defaultRadiusMiles, false);
  CW.load().then(() => { if (state.stateRecs.length || state.countyRecs.length) { CW.apply(state.stateRecs, state.countyRecs, { lat: state.lat, lon: state.lon }); applyFilters(); } });
  if (qp.get('all') === '1') $('optAllUses').checked = true;
  setView(qp.get('view') || C.defaultView);
  const qlat = parseFloat(qp.get('lat')), qlon = parseFloat(qp.get('lon'));
  if (Number.isFinite(qlat) && Number.isFinite(qlon)) setLocation(qlat, qlon, 'from link');
  else locate();

  window.WellsApp = { state, map, search, setLocation, setView };
})();
