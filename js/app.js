/* Wells Nearby — UI: geolocation, map, summary, table. */
(function () {
  'use strict';
  const C = window.WELLS_CONFIG, D = window.WellsData, S = window.WellsStats;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));

  const state = { lat: null, lon: null, radius: C.defaultRadiusMiles, all: [], shown: [], sort: { key: 'distanceMi', dir: 1 }, groups: new Map(), source: '' };

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
  const wellLayer = L.layerGroup().addTo(map);
  const meLayer = L.layerGroup().addTo(map);
  L.control.layers({ 'Satellite': imagery, 'Streets': streets }, { 'Roads & labels': labels, 'Wells': wellLayer }, { collapsed: true }).addTo(map);
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
  $('radius').onchange = () => { if (state.lat != null) search(); };
  $('optAllUses').onchange = $('optDestroyed').onchange = () => applyFilters();
  $('btnCsv').onclick = downloadCsv;

  function setStatus(msg, err) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', !!err); }

  function locate() {
    if (!('geolocation' in navigator)) return setStatus('Geolocation not available — enter coordinates manually.', true);
    setStatus('Getting your location…');
    navigator.geolocation.getCurrentPosition(
      (p) => setLocation(p.coords.latitude, p.coords.longitude, `GPS ±${Math.round(p.coords.accuracy * 3.281)} ft`),
      (e) => setStatus(`Location unavailable (${e.message || 'denied'}). Enter lat/lon manually or tap the map.`, true),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }

  function setLocation(lat, lon, how) {
    state.lat = lat; state.lon = lon; state.how = how;
    $('lat').value = lat.toFixed(5); $('lon').value = lon.toFixed(5);
    const u = new URL(location.href);
    u.searchParams.set('lat', lat.toFixed(5)); u.searchParams.set('lon', lon.toFixed(5)); u.searchParams.set('r', $('radius').value);
    history.replaceState(null, '', u);
    search();
  }

  async function search() {
    state.radius = parseFloat($('radius').value);
    const { lat, lon, radius } = state;
    drawMe();
    setStatus(`Searching ${radius} mi around ${lat.toFixed(5)}, ${lon.toFixed(5)}…`);
    const t0 = performance.now();
    try {
      const res = await D.queryNearby(lat, lon, radius);
      state.all = res.records; state.source = res.source;
      const note = res.errors.length ? ` (primary failed, used fallback)` : '';
      setStatus(`${res.records.length} records within ${radius} mi · ${res.source}${note} · ${Math.round(performance.now() - t0)} ms${res.truncated ? ' · RESULT TRUNCATED, reduce radius' : ''}`);
      applyFilters();
    } catch (e) {
      console.error(e);
      setStatus('Could not load well data: ' + e.message, true);
    }
  }

  function applyFilters() {
    const allUses = $('optAllUses').checked, destroyed = $('optDestroyed').checked;
    state.shown = state.all.filter((w) => (allUses || w.waterSupply) && (destroyed || !w.destruction));
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

  function renderMarkers() {
    wellLayer.clearLayers(); state.groups.clear();
    // Many WCRs share the same (section-centroid) coordinates: group them into one marker.
    for (const w of state.shown) {
      if (w.lat == null) continue;
      const k = w.lat.toFixed(5) + ',' + w.lon.toFixed(5);
      if (!state.groups.has(k)) state.groups.set(k, []);
      state.groups.get(k).push(w);
    }
    for (const [k, ws] of state.groups) {
      const counts = {}; ws.forEach((w) => (counts[w.methodKey] = (counts[w.methodKey] || 0) + 1));
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      const color = C.methodCategories.find((c) => c.key === top).color;
      const size = ws.length > 1 ? Math.min(34, 20 + Math.log2(ws.length) * 3) : 16;
      const m = L.marker([ws[0].lat, ws[0].lon], {
        icon: L.divIcon({ className: '', html: `<div class="well-pin" style="width:${size}px;height:${size}px;background:${color}">${ws.length > 1 ? ws.length : ''}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      }).bindPopup(() => groupPopup(ws), { maxWidth: 300 });
      m.addTo(wellLayer);
      ws.forEach((w) => (w._marker = m));
    }
  }

  function wellDetails(w) {
    const rows = [
      ['Depth', w.depthFt != null ? fmt(w.depthFt) + ' ft' : '—'],
      ['Method', `${w.methodLabel} <small>(${esc(w.methodDetail)})</small>`],
      ['Yield', w.gpm != null ? fmt(w.gpm, 1) + ' GPM' : (w.yieldZero ? '0 (dry?)' : '—')],
      ['SWL', w.swlFt != null ? fmt(w.swlFt) + ' ft' : '—'],
      ['Date', w.dateStr],
      ['Use', esc(w.plannedUse || w.b118Use || '—')],
      ['Record', esc(w.recordType || '—')],
      ['Casing Ø', esc(w.casingDiameter || '—')],
      ['Perfs', w.perfTop || w.perfBottom ? `${esc(w.perfTop || '?')}–${esc(w.perfBottom || '?')} ft` : '—'],
      ['Driller', esc(w.driller || '—')],
      ['Distance', w.distanceMi != null ? fmt(w.distanceMi, 2) + ' mi' : '—'],
      ['Loc. accuracy', esc(w.llAccuracy || 'not recorded')],
    ];
    const pdf = w.pdfUrl ? ` · <a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">WCR PDF</a>` : '';
    return `<b>${esc(w.wcr || w.legacyLog || 'WCR ?')}</b>${pdf}<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
  }

  function groupPopup(ws) {
    if (ws.length === 1) return `<div class="popup">${wellDetails(ws[0])}</div>`;
    const acc = ws[0].llAccuracy ? ` — ${esc(ws[0].llAccuracy)}` : '';
    const sorted = [...ws].sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
    return `<div class="popup"><h3>${ws.length} wells at this point${acc}</h3><div class="list">${sorted.map((w) =>
      `<div class="item"><b>${esc(w.wcr || '?')}</b> · ${w.depthFt != null ? fmt(w.depthFt) + ' ft' : '— ft'} · ${w.gpm != null ? fmt(w.gpm, 1) + ' gpm' : '— gpm'} · SWL ${w.swlFt != null ? fmt(w.swlFt) : '—'} · ${w.methodLabel} · ${w.dateStr}${w.pdfUrl ? ` · <a href="${esc(w.pdfUrl)}" target="_blank" rel="noopener">PDF</a>` : ''}</div>`).join('')}</div></div>`;
  }

  // ---------- Summary ----------
  function renderSummary() {
    const s = S.summarize(state.shown);
    const el = $('summary'); el.classList.remove('hidden');
    const stat = (k, v, d) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const methods = s.methods.filter((m) => m.count);
    const noteStacked = s.uniqueLocations < s.total ? `${s.total} wells at ${s.uniqueLocations} distinct map points. ` : '';
    el.innerHTML = `
      <h2>Within ${state.radius} mi · ${s.total} wells</h2>
      ${s.total === 0 ? '<p>No matching wells. Try a larger radius or include all uses.</p>' : `
      <div class="stats">
        ${stat('Avg depth', fmt(s.depth.avg) + ' <small>ft</small>', `min ${fmt(s.depth.min)} · max ${fmt(s.depth.max)} · median ${fmt(s.depth.median)} · n=${s.depth.n}`)}
        ${stat('Avg yield', fmt(s.gpm.avg, 1) + ' <small>GPM</small>', `median ${fmt(s.gpm.median, 1)} · range ${fmt(s.gpm.min, 1)}–${fmt(s.gpm.max)} · n=${s.gpm.n}${s.yieldZeroCount ? ` · ${s.yieldZeroCount} reported 0` : ''}`)}
        ${stat('Avg static water level', fmt(s.swl.avg) + ' <small>ft bgs</small>', `median ${fmt(s.swl.median)} · range ${fmt(s.swl.min)}–${fmt(s.swl.max)} · n=${s.swl.n}`)}
        ${stat('Year drilled', s.year.n ? `${s.year.min}–${s.year.max}` : '—', `median ${s.year.median != null ? Math.round(s.year.median) : '—'} · n=${s.year.n}`)}
      </div>
      <div class="methods">
        <div class="k" style="font-size:12px;color:#64748b;margin-bottom:4px">DRILLING METHOD</div>
        <div class="bar">${methods.map((m) => `<span title="${m.label}" style="width:${m.pct}%;background:${m.color}"></span>`).join('')}</div>
        <div class="legend">${methods.map((m) => `<span><i style="background:${m.color}"></i>${m.label}: <b>${m.count}</b> (${m.pct.toFixed(0)}%)</span>`).join('')}</div>
      </div>
      <div class="meta">${noteStacked}Location accuracy: ${s.accuracy.map(([k, v]) => `${esc(k)} ${v}`).join(', ')}.</div>`}`;
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
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    const t = $('wellTable');
    t.innerHTML = `<thead><tr>${cols.map((c) => `<th data-k="${c.key}" class="${c.num ? 'num' : ''}">${c.label}${c.key === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((w, i) => `<tr data-i="${i}">${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${esc(c.fmt ? c.fmt(w[c.key]) : (w[c.key] ?? '—'))}</td>`).join('')}</tr>`).join('')}</tbody>`;
    t.querySelectorAll('th').forEach((th) => (th.onclick = () => {
      const k = th.dataset.k; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 }; renderTable();
    }));
    t.querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => {
      const w = rows[+tr.dataset.i];
      t.querySelectorAll('tr.sel').forEach((r) => r.classList.remove('sel')); tr.classList.add('sel');
      if (w._marker) {
        L.popup({ maxWidth: 300 }).setLatLng(w._marker.getLatLng()).setContent(`<div class="popup">${wellDetails(w)}</div>`).openOn(map);
        document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }));
  }

  function downloadCsv() {
    const f = ['wcr', 'distanceMi', 'lat', 'lon', 'llAccuracy', 'depthFt', 'methodLabel', 'method', 'fluid', 'gpm', 'swlFt', 'dateStr', 'plannedUse', 'recordType', 'casingDiameter', 'driller', 'pdfUrl'];
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const csv = [f.join(',')].concat(state.shown.map((w) => f.map((k) => q(k === 'distanceMi' && w[k] != null ? w[k].toFixed(3) : w[k])).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `wells_${state.lat.toFixed(4)}_${state.lon.toFixed(4)}_${state.radius}mi.csv`;
    a.click();
  }

  // ---------- Startup ----------
  const qp = new URLSearchParams(location.search);
  if (qp.get('r') && C.radiusOptions.includes(+qp.get('r'))) $('radius').value = qp.get('r');
  if (qp.get('all') === '1') $('optAllUses').checked = true;
  const qlat = parseFloat(qp.get('lat')), qlon = parseFloat(qp.get('lon'));
  if (Number.isFinite(qlat) && Number.isFinite(qlon)) setLocation(qlat, qlon, 'from link');
  else locate();

  window.WellsApp = { state, map, search, setLocation };
})();
