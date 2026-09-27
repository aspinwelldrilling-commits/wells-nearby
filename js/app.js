/* Wells Nearby — UI: geolocation, map, summary, table. */
(function () {
  'use strict';
  const C = window.WELLS_CONFIG, D = window.WellsData, S = window.WellsStats, M = window.WellsMatch;
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
    const { lat, lng } = e.latlng;
    L.popup().setLatLng(e.latlng).setContent(
      `<div class="popup">${lat.toFixed(5)}, ${lng.toFixed(5)}<br><button class="small" id="searchHere">Search here</button></div>`).openOn(map);
    setTimeout(() => { const b = $('searchHere'); if (b) b.onclick = () => { map.closePopup(); setLocation(lat, lng, 'map tap'); }; }, 0);
  });

  // ---------- Controls ----------
  C.radiusOptions.forEach((r) => { const o = document.createElement('option'); o.value = r; o.textContent = `${r} mi`; $('radius').appendChild(o); });
  $('radius').value = String(C.defaultRadiusMiles);
  $('btnLocate').onclick = locate;
  $('btnSearch').onclick = () => {
    const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return setStatus('Enter a valid latitude and longitude (e.g. 33.0417, -116.8681).', true);
    setLocation(lat, lon, 'manual');
  };
  $('radius').onchange = () => { if (state.lat != null) { updateUrl(); search(); } };
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
    u.searchParams.set('r', $('radius').value); u.searchParams.set('view', state.view);
    history.replaceState(null, '', u);
  }

  function setLocation(lat, lon, how) {
    state.lat = lat; state.lon = lon; state.how = how;
    $('lat').value = lat.toFixed(5); $('lon').value = lon.toFixed(5);
    updateUrl();
    search();
  }

  async function search() {
    state.radius = parseFloat($('radius').value);
    const { lat, lon, radius } = state, id = ++state.reqId;
    drawMe();
    setStatus(`Searching ${radius} mi around ${lat.toFixed(5)}, ${lon.toFixed(5)}…`);
    const t0 = performance.now();
    // Fetch a buffer beyond the radius so duplicates straddling the edge still pair up; views are cut back to the radius.
    const res = await D.queryAll(lat, lon, radius + C.matching.bufferMiles);
    if (id !== state.reqId) return; // a newer search started
    state.stateRecs = res.state.records; state.countyRecs = res.county.records;
    M.findMatches(state.stateRecs, state.countyRecs);
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
  }

  function applyFilters() {
    if (state.lat == null) return;
    const allUses = $('optAllUses').checked, destroyed = $('optDestroyed').checked;
    const view = M.buildView(state.view, state.stateRecs, state.countyRecs, state.radius);
    state.shown = view.filter((w) => (allUses || w.waterSupply) && (destroyed || !w.destruction));
    renderSummary(); renderMarkers(); renderTable();
  }

  // ---------- Map drawing ----------
  function drawMe() {
    meLayer.clearLayers();
    const ll = [state.lat, state.lon];
    L.circle(ll, { radius: state.radius * 1609.344, color: '#38bdf8', weight: 2, fillOpacity: 0.05, interactive: false }).addTo(meLayer);
    L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 })
      .bindPopup(`<div class="popup"><h3>Your location</h3>${state.lat.toFixed(6)}, ${state.lon.toFixed(6)}<br>${esc(state.how || '')}</div>`).addTo(meLayer);
    map.fitBounds(L.latLng(ll).toBounds(state.radius * 1609.344 * 2.1));
  }

  function pinIcon(ws) {
    const counts = {}; ws.forEach((w) => (counts[w.methodKey] = (counts[w.methodKey] || 0) + 1));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const color = C.methodCategories.find((c) => c.key === top).color;
    const size = ws.length > 1 ? Math.min(34, 20 + Math.log2(ws.length) * 3) : 16;
    const g = ws[0].group; // state | county | both
    const label = ws.length > 1 ? ws.length : '';
    return L.divIcon({ className: '', html: `<div class="well-pin pin-${g}" style="width:${size}px;height:${size}px;background:${color}">${label}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
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
      const m = L.marker([ws[0].lat, ws[0].lon], { icon: pinIcon(ws), zIndexOffset: ws[0].group === 'county' ? 0 : 100 })
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
      row('Opened', c.dateStr),
      row('Work', esc(c.recordType || '—') + (c.status ? ` <small>(${esc(c.status)})</small>` : '')),
      row('Use', esc(c.wellUse || '—')),
      row('Address', esc(c.address || '—')),
      row('APN', esc(c.apn || '—')),
    ].join('');
  }

  function wellDetails(w) {
    const g = C.groups[w.group];
    const src = `<div class="srcTag src-${w.group}">${esc(g.label)}</div>`;
    const rowsLog = [
      row('Depth', w.depthFt != null ? fmt(w.depthFt) + ' ft' : '—'),
      row('Method', `${w.methodLabel} <small>(${esc(w.methodDetail)})</small>`),
      row('Yield', w.gpm != null ? fmt(w.gpm, 1) + ' GPM' : (w.yieldZero ? '0 (dry?)' : '—')),
      row('SWL', w.swlFt != null ? fmt(w.swlFt) + ' ft' : '—'),
    ];
    if (w.group === 'county') {
      const mt = w.matches.length ? `<div class="dup">${esc(w.matchLabel)} same well as state ${esc(w.wcr)} — ${esc(w.matches[0].reason)}. Log values below are from that WCR.</div>` : '<div class="dup none">No matching state WCR found — permit record only.</div>';
      const pdf = w.pdfUrl ? ` · <a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">WCR PDF</a>` : '';
      return `${src}<b>${esc(w.permit)}</b>${pdf}${mt}<table>${countyRows(w)}${w.matches.length ? rowsLog.join('') : ''}${row('Distance', fmt(w.distanceMi, 2) + ' mi')}${row('Loc. accuracy', esc(w.llAccuracy))}</table>`;
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
    return `${src}<b>${esc(w.wcr || w.legacyLog || 'WCR ?')}</b>${pdf}${dup}<table>${rows.join('')}</table>${ctab}`;
  }

  function groupPopup(ws) {
    if (ws.length === 1) return `<div class="popup">${wellDetails(ws[0])}</div>`;
    const acc = ws[0].llAccuracy ? ` — ${esc(ws[0].llAccuracy)}` : '';
    const sorted = [...ws].sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
    const g = C.groups[ws[0].group];
    return `<div class="popup"><div class="srcTag src-${ws[0].group}">${esc(g.label)}</div><h3>${ws.length} records at this point${acc}</h3><div class="list">${sorted.map((w) =>
      `<div class="item"><b>${esc(w.wcr || w.permit || '?')}</b>${w.matchLabel ? ` <span class="dupTag">dup: ${esc(w.matchLabel)}</span>` : ''} · ${w.depthFt != null ? fmt(w.depthFt) + ' ft' : '— ft'} · ${w.gpm != null ? fmt(w.gpm, 1) + ' gpm' : '— gpm'} · SWL ${w.swlFt != null ? fmt(w.swlFt) : '—'} · ${esc(w.methodLabel)} · ${w.dateStr}${w.pdfUrl ? ` · <a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">PDF</a>` : ''}</div>`).join('')}</div></div>`;
  }

  // ---------- Summary ----------
  function renderSummary() {
    const s = S.summarize(state.shown);
    const el = $('summary'); el.classList.remove('hidden');
    const stat = (k, v, d) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const methods = s.methods.filter((m) => m.count);
    const noteStacked = s.uniqueLocations < s.total ? `${s.total} records at ${s.uniqueLocations} distinct map points. ` : '';
    const nCounty = state.shown.filter((w) => w.group === 'county').length;
    const nNoLog = state.shown.filter((w) => w.methodKey === 'nolog').length;
    const nDup = state.shown.filter((w) => w.matchLabel).length;
    const viewNote = {
      state: `State WCRs only. ${nDup} have a likely/possible county-permit duplicate.`,
      county: `County permits only (unincorporated area, permits opened through 2020). Depth/yield/SWL/method come from the matched state WCR; ${nNoLog} of ${nCounty} permits have no match (no log data). Year = permit date.`,
      both: `State WCRs + county permits with duplicates merged (${nDup} merged pairs, drawn at the county parcel point). ${nNoLog} county permits have no WCR match (no log data). Year = drilled date, or permit date for county-only.`,
    }[state.view];
    el.innerHTML = `
      <h2>${esc(C.groups[state.view].label)} · within ${state.radius} mi · ${s.total} wells</h2>
      ${s.total === 0 ? '<p>No matching wells. Try a larger radius, another data view, or include all uses.</p>' : `
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
      <tbody>${rows.map((w, i) => `<tr data-i="${i}" class="row-${w.group}">${cols.map((c) => `<td class="${c.num ? 'num' : ''} col-${c.key}">${esc(c.fmt ? c.fmt(w[c.key]) : (w[c.key] || '—'))}</td>`).join('')}</tr>`).join('')}</tbody>`;
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
  if (qp.get('r') && C.radiusOptions.includes(+qp.get('r'))) $('radius').value = qp.get('r');
  if (qp.get('all') === '1') $('optAllUses').checked = true;
  setView(qp.get('view') || C.defaultView);
  const qlat = parseFloat(qp.get('lat')), qlon = parseFloat(qp.get('lon'));
  if (Number.isFinite(qlat) && Number.isFinite(qlon)) setLocation(qlat, qlon, 'from link');
  else locate();

  window.WellsApp = { state, map, search, setLocation, setView };
})();
