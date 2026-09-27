/* Wells Nearby — proposed well sites: GPS-tag a site in the field, look up the parcel (APN), customer name/phone/notes/photo.
 * Everything is stored ON THIS DEVICE (IndexedDB). Nothing about the customer is sent anywhere; the only network call is
 * the parcel lookup, which sends just the coordinates to the County GIS server.
 */
(function () {
  'use strict';
  const C = window.WELLS_CONFIG, A = window.WellsApp, map = A.map;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FT = 3.28084;
  const ftOf = (m) => (m == null ? null : Math.round(m * FT));

  // ---------------------------------------------------------------- storage (IndexedDB, one object store)
  const DB_NAME = 'wells-nearby', STORE = 'sites';
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
      const out = fn(st);
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  const Store = {
    all: () => tx('readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => (y.created || '').localeCompare(x.created || ''))),
    put: (rec) => tx('readwrite', (s) => s.put(rec)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------------------------------------------------------------- parcel lookup (coordinates only)
  const fmtApn = (a) => { const d = String(a || '').replace(/\D/g, ''); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}` : (a || ''); };
  function situs(a) {
    if (!a.SITUS_STREET) return '';
    const num = a.SITUS_ADDRESS ? a.SITUS_ADDRESS + (a.SITUS_FRACTION ? ' ' + a.SITUS_FRACTION : '') : '';
    const street = [num, a.SITUS_PRE_DIR, a.SITUS_STREET, a.SITUS_SUFFIX, a.SITUS_POST_DIR].filter((x) => x && String(x).trim()).join(' ');
    return [street + (a.SITUS_SUITE && a.SITUS_SUITE.trim() ? ' #' + a.SITUS_SUITE.trim() : ''), [a.SITUS_COMMUNITY, (a.SITUS_ZIP || '').slice(0, 5)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }
  function simplifyRings(rings, max = 400) {
    return rings.map((r) => { const step = Math.max(1, Math.ceil(r.length / max)); return r.filter((_, i) => i % step === 0 || i === r.length - 1).map(([x, y]) => [+y.toFixed(6), +x.toFixed(6)]); });
  }
  async function lookupParcel(lat, lon) {
    const P = C.parcels;
    const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: P.outFields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' });
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), P.timeoutMs);
    try {
      const r = await fetch(P.url + '?' + q, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'server error');
      const f = (j.features || [])[0];
      if (!f) return { found: false };
      const a = f.attributes, area = a['Shape.STArea()'];
      return { found: true, apn: fmtApn(a.APN), address: situs(a), acreage: a.ACREAGE || (area ? +(area / 43560).toFixed(2) : null),
        acreageSrc: a.ACREAGE ? 'assessor' : 'GIS polygon area', owner: (a.OWN_NAME1 || '').trim(), legal: (a.LEGLDESC || '').replace(/\\/g, ' ').trim(),
        rings: f.geometry && f.geometry.rings ? simplifyRings(f.geometry.rings) : null };
    } finally { clearTimeout(t); }
  }
  function applyParcel(rec, p) {
    rec.apnCheckedAt = new Date().toISOString();
    if (!p.found) { rec.apnStatus = rec.apn ? 'manual' : 'none'; rec.parcel = null; rec.address = ''; return; }
    if (!rec.apn || rec.apnSource !== 'manual') { rec.apn = p.apn; rec.apnSource = 'lookup'; }
    rec.apnStatus = rec.apnSource === 'manual' && rec.apn !== p.apn ? 'manual' : 'ok';
    rec.parcel = { apn: p.apn, address: p.address, acreage: p.acreage, acreageSrc: p.acreageSrc, owner: p.owner, legal: p.legal, rings: p.rings };
    rec.address = p.address || '';
  }

  // ---------------------------------------------------------------- map layers
  const sitesLayer = L.layerGroup().addTo(map);
  const draftLayer = L.layerGroup().addTo(map);
  // Teardrop pin whose tip is exactly the site point (anchor = bottom center).
  const PIN_SVG = (fill) => `<svg viewBox="0 0 32 44" width="32" height="44"><path d="M16 43C16 43 2 25.5 2 15.5A14 14 0 0 1 30 15.5C30 25.5 16 43 16 43Z" fill="${fill}" stroke="#fff" stroke-width="2.5"/><circle cx="16" cy="15.5" r="6.5" fill="#fff"/><path d="M16 10.5v10M12.5 13.5h7" stroke="${fill}" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const siteIcon = (cls = '') => L.divIcon({ className: '', html: `<div class="site-pin ${cls}">${PIN_SVG(cls === 'draft' ? '#ea580c' : cls === 'pending' ? '#a16207' : '#facc15')}</div>`, iconSize: [32, 44], iconAnchor: [16, 43], popupAnchor: [0, -38] });
  let sites = [];

  function drawSites() {
    sitesLayer.clearLayers();
    for (const s of sites) {
      if (editing && editing.id === s.id) continue;
      const m = L.marker([s.lat, s.lon], { icon: siteIcon(s.apnStatus === 'pending' ? 'pending' : ''), zIndexOffset: 2000, title: s.customer });
      m.bindPopup(() => sitePopup(s), { maxWidth: 290 });
      m.addTo(sitesLayer);
    }
  }
  function sitePopup(s) {
    const div = document.createElement('div');
    div.className = 'popup site-popup';
    div.innerHTML = `<h3>📌 ${esc(s.customer)}</h3>
      <table>
        <tr><td>APN</td><td><b>${esc(s.apn || '—')}</b> ${apnBadge(s)}</td></tr>
        ${s.address ? `<tr><td>Address</td><td>${esc(s.address)}</td></tr>` : ''}
        <tr><td>GPS</td><td>${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}<br><small>${gpsNote(s)}</small></td></tr>
        ${s.phone ? `<tr><td>Phone</td><td><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></td></tr>` : ''}
        ${s.notes ? `<tr><td>Notes</td><td>${esc(s.notes)}</td></tr>` : ''}
        <tr><td>Tagged</td><td>${esc(when(s.created))}</td></tr>
      </table>
      ${s.photo ? `<img class="site-photo" src="${s.photo}" alt="site photo">` : ''}
      <div class="site-actions"></div>`;
    actionButtons(s, div.querySelector('.site-actions'), true);
    return div;
  }
  const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso || ''; } };
  function gpsNote(s) {
    const g = s.gps || {};
    const parts = [];
    if (g.accuracyFt != null) parts.push(`GPS ±${g.accuracyFt} ft`);
    if (s.adjusted) parts.push(`pin moved ${s.adjustedFt != null ? s.adjustedFt + ' ft ' : ''}by hand`);
    if (g.manual) parts.push('placed by hand (no GPS fix)');
    return esc(parts.join(' · '));
  }
  function apnBadge(s) {
    if (s.apnStatus === 'pending') return '<span class="badge warn">lookup pending</span>';
    if (s.apnStatus === 'none') return '<span class="badge warn">no parcel found</span>';
    if (s.apnStatus === 'manual') return '<span class="badge">typed</span>';
    return s.apn ? '<span class="badge ok">County GIS</span>' : '';
  }

  // ---------------------------------------------------------------- actions (directions, wells, share, edit, delete)
  const gmapsUrl = (s) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat.toFixed(6)},${s.lon.toFixed(6)}`;
  function summaryText(s) {
    return [`Proposed well site — ${s.customer}`, s.phone ? `Phone: ${s.phone}` : '', `APN: ${s.apn || '(not looked up yet)'}`, s.address ? `Address: ${s.address}` : '',
      `GPS: ${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}${s.gps && s.gps.accuracyFt != null ? ` (±${s.gps.accuracyFt} ft)` : ''}${s.adjusted ? ' (pin adjusted)' : ''}`,
      `Map: https://www.google.com/maps/search/?api=1&query=${s.lat.toFixed(6)},${s.lon.toFixed(6)}`, s.notes ? `Notes: ${s.notes}` : '', `Tagged: ${when(s.created)}`].filter(Boolean).join('\n');
  }
  async function share(s) {
    const text = summaryText(s);
    if (navigator.share) { try { await navigator.share({ title: `Well site — ${s.customer}`, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text); toast('Copied site summary'); } catch (e) { prompt('Copy the site summary:', text); }
  }
  function actionButtons(s, el, inPopup) {
    const b = (label, fn, cls = '') => { const x = document.createElement(fn ? 'button' : 'a'); x.className = 'small ' + cls; x.innerHTML = label; if (fn) x.onclick = (e) => { e.stopPropagation(); fn(); }; el.appendChild(x); return x; };
    b('💧 Wells nearby', () => wellsFor(s), 'act-wells');
    const g = b('🧭 Directions', null, 'act-dir'); g.href = gmapsUrl(s); g.target = '_blank'; g.rel = 'noopener'; g.classList.add('btnlink');
    b('📤 Share', () => share(s));
    if (!inPopup) b('🗺 Map', () => showOnMap(s));
    b('✏️ Edit', () => openForm(s));
    if (s.apnStatus === 'pending' || s.apnStatus === 'none') b('🔎 Look up APN', () => retryLookup(s));
    b('🗑', () => removeSite(s), 'danger');
  }
  function wellsFor(s) {
    map.closePopup(); closeSheet();
    A.setLocation(s.lat, s.lon, `site: ${s.customer}`);
    setTimeout(() => $('summary').scrollIntoView({ behavior: 'smooth', block: 'start' }), 900);
  }
  function showOnMap(s) {
    closeSheet();
    $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    map.setView([s.lat, s.lon], 18);
    showParcel(s.parcel);
    sitesLayer.eachLayer((m) => { const ll = m.getLatLng(); if (Math.abs(ll.lat - s.lat) < 1e-9 && Math.abs(ll.lng - s.lon) < 1e-9) m.openPopup(); });
  }
  async function removeSite(s) {
    if (!confirm(`Delete the site for "${s.customer}"?\nThis cannot be undone (export a backup first if unsure).`)) return;
    await Store.del(s.id); map.closePopup(); await refresh(); toast('Site deleted');
    if (!$('sheet').classList.contains('hidden') && sheetMode === 'list') renderList();
  }
  async function retryLookup(s) {
    toast('Looking up parcel…');
    try { applyParcel(s, await lookupParcel(s.lat, s.lon)); s.updated = new Date().toISOString(); await Store.put(s); toast(s.apn ? `APN ${s.apn}` : 'No parcel at this point'); }
    catch (e) { s.apnStatus = 'pending'; await Store.put(s); toast('Still offline — will retry automatically'); }
    await refresh(); if (sheetMode === 'list' && !$('sheet').classList.contains('hidden')) renderList();
  }
  async function retryPending() {
    if (navigator.onLine === false) return;
    const pend = sites.filter((s) => s.apnStatus === 'pending');
    for (const s of pend) {
      try { applyParcel(s, await lookupParcel(s.lat, s.lon)); s.updated = new Date().toISOString(); await Store.put(s); } catch (e) { return; }
    }
    if (pend.length) { await refresh(); toast(`Looked up ${pend.length} pending APN${pend.length > 1 ? 's' : ''}`); }
  }
  window.addEventListener('online', retryPending);

  // ---------------------------------------------------------------- parcel outline
  const parcelLayer = L.layerGroup().addTo(map);
  function showParcel(p) {
    parcelLayer.clearLayers();
    if (p && p.rings) L.polygon(p.rings, { color: '#facc15', weight: 3, fillColor: '#facc15', fillOpacity: 0.08, interactive: false }).addTo(parcelLayer);
  }

  // ---------------------------------------------------------------- bottom sheet
  let sheetMode = '', editing = null, watchId = null, gpsTimer = null, draftMarker = null;
  function openSheet(mode, html) {
    sheetMode = mode;
    const sh = $('sheet');
    sh.innerHTML = html; sh.classList.remove('hidden'); document.body.classList.add('sheet-open');
    $('bottomBar').classList.add('hidden');
    sh.scrollTop = 0;
  }
  function closeSheet() {
    stopGps();
    const sh = $('sheet'); sh.classList.add('hidden'); sh.innerHTML = ''; document.body.classList.remove('sheet-open');
    $('bottomBar').classList.remove('hidden');
    sheetMode = ''; editing = null; draftLayer.clearLayers(); draftMarker = null; drawSites();
  }
  let toastT = null;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

  // ---------------------------------------------------------------- 1) GPS capture
  const accClass = (ft) => (ft == null ? '' : ft <= C.siteGps.goodFt ? 'good' : ft <= C.siteGps.okFt ? 'ok' : 'poor');
  function startTag() {
    const G = C.siteGps;
    openSheet('gps', `<div class="sheet-head"><b>📌 Tag proposed well site</b><button class="small" id="gpsCancel">Cancel</button></div>
      <div class="gps-live" id="gpsLive"><div class="acc" id="gpsAcc">Waiting for GPS…</div><div class="gps-sub" id="gpsSub">Stand at the proposed well spot. Accuracy improves over ~${G.maxWaitS} s.</div>
      <div class="gps-bar"><span id="gpsBar"></span></div></div>
      <button class="big" id="gpsCapture" disabled>Capture this spot</button>
      <button class="small wide" id="gpsManual">No GPS? Place the pin on the map instead</button>`);
    $('gpsCancel').onclick = closeSheet;
    $('gpsManual').onclick = () => { const c = map.getCenter(); capture({ lat: c.lat, lon: c.lng, accuracyFt: null, fixes: 0, manual: true, time: new Date().toISOString() }); };
    $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    let best = null, fixes = 0; const t0 = Date.now();
    const cap = $('gpsCapture');
    cap.onclick = () => best && capture(best);
    const accCircle = L.circle([0, 0], { radius: 1, color: '#facc15', weight: 2, fillOpacity: 0.1, interactive: false });
    const upd = () => {
      const el = Math.round((Date.now() - t0) / 1000), done = el >= G.maxWaitS;
      $('gpsBar').style.width = Math.min(100, (el / G.maxWaitS) * 100) + '%';
      if (!best) { $('gpsSub').textContent = el > 20 ? 'No fix yet — check that Location is on, or place the pin by hand.' : `Searching… ${el}s`; return; }
      const cls = accClass(best.accuracyFt);
      $('gpsAcc').className = 'acc ' + cls;
      $('gpsAcc').innerHTML = `±${best.accuracyFt} ft <small>${cls === 'good' ? 'good' : cls === 'ok' ? 'fair' : 'poor'}</small>`;
      $('gpsSub').textContent = `${fixes} fix${fixes === 1 ? '' : 'es'} · best of ${el}s${done ? ' — done refining' : ` (refining up to ${G.maxWaitS}s)`} · ${best.lat.toFixed(6)}, ${best.lon.toFixed(6)}`;
      cap.disabled = false;
      cap.className = 'big ' + cls;
      cap.textContent = cls === 'good' || done ? `Capture (±${best.accuracyFt} ft)` : `Capture anyway (±${best.accuracyFt} ft)`;
      if (done) stopGps(true);
    };
    gpsTimer = setInterval(upd, 1000);
    if (!('geolocation' in navigator)) { $('gpsSub').textContent = 'Geolocation not available — place the pin by hand.'; return; }
    watchId = navigator.geolocation.watchPosition((p) => {
      fixes++;
      const f = { lat: p.coords.latitude, lon: p.coords.longitude, accuracyFt: ftOf(p.coords.accuracy), altitudeFt: ftOf(p.coords.altitude), fixes, time: new Date(p.timestamp || Date.now()).toISOString() };
      if (!best || f.accuracyFt <= best.accuracyFt) best = f;
      best.fixes = fixes;
      accCircle.setLatLng([best.lat, best.lon]).setRadius(best.accuracyFt / FT);
      if (!draftLayer.hasLayer(accCircle)) { accCircle.addTo(draftLayer); map.setView([best.lat, best.lon], 18); }
      upd();
    }, (e) => { $('gpsSub').textContent = `GPS error: ${e.message || e.code}. You can place the pin by hand.`; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps(keepTimer) {
    if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (!keepTimer && gpsTimer) { clearInterval(gpsTimer); gpsTimer = null; }
    if (keepTimer && gpsTimer) { clearInterval(gpsTimer); gpsTimer = null; }
  }
  function capture(fix) {
    stopGps();
    const now = new Date().toISOString();
    const rec = { id: 'site-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: now, updated: now, customer: '', phone: '', notes: '',
      lat: fix.lat, lon: fix.lon, gps: fix, adjusted: false, adjustedFt: null, apn: '', apnSource: '', apnStatus: 'pending', address: '', parcel: null, photo: null, _new: true };
    openForm(rec);
  }

  // ---------------------------------------------------------------- 2+3) form (new or edit), draggable pin, parcel lookup
  function openForm(rec) {
    stopGps();
    map.closePopup();
    editing = rec;
    const isNew = !!rec._new;
    openSheet('form', `<div class="sheet-head"><b>${isNew ? '📌 New well site' : '✏️ Edit site'}</b><button class="small" id="fCancel">Cancel</button></div>
      <div class="f-gps" id="fGps"></div>
      <div class="f-parcel" id="fParcel"></div>
      <label>Customer name *<input id="fName" type="text" autocomplete="off" autocapitalize="words" value="${esc(rec.customer)}" required></label>
      <label>Phone<input id="fPhone" type="tel" inputmode="tel" value="${esc(rec.phone)}"></label>
      <label>APN <small id="fApnSrc"></small><input id="fApn" type="text" inputmode="numeric" placeholder="###-###-##-##" value="${esc(rec.apn)}"></label>
      <label>Notes<textarea id="fNotes" rows="3" placeholder="access, gate code, power, septic location…">${esc(rec.notes)}</textarea></label>
      <div class="f-photo"><label class="photo-btn">📷 ${rec.photo ? 'Replace photo' : 'Add photo'}<input id="fPhoto" type="file" accept="image/*" capture="environment" hidden></label>
        <span id="fPhotoInfo">${rec.photo ? 'photo attached' : ''}</span> ${rec.photo ? '<button class="small" id="fPhotoDel">remove</button>' : ''}
        <img id="fPhotoPrev" class="site-photo ${rec.photo ? '' : 'hidden'}" src="${rec.photo || ''}" alt=""></div>
      <div class="f-err" id="fErr"></div>
      <div class="sticky-save"><button class="big good" id="fSave">💾 Save site</button></div>`);
    $('fCancel').onclick = closeSheet;
    // draggable pin
    draftLayer.clearLayers(); sitesLayer.eachLayer(() => {}); drawSites();
    draftMarker = L.marker([rec.lat, rec.lon], { icon: siteIcon('draft'), draggable: true, zIndexOffset: 3000, autoPan: true }).addTo(draftLayer);
    draftMarker.on('dragend', () => {
      const ll = draftMarker.getLatLng(), g = rec.gps || {};
      rec.lat = ll.lat; rec.lon = ll.lng;
      if (g.lat != null && !g.manual) { rec.adjusted = true; rec.adjustedFt = Math.round(L.latLng(g.lat, g.lon).distanceTo(ll) * FT); }
      else if (g.manual) { g.lat = ll.lat; g.lon = ll.lng; }
      renderGps(); doLookup();
    });
    map.setView([rec.lat, rec.lon], Math.max(map.getZoom(), 18));
    showParcel(rec.parcel);
    renderGps(); renderParcel();
    $('fPhoto').onchange = async (e) => {
      const file = e.target.files && e.target.files[0]; if (!file) return;
      $('fPhotoInfo').textContent = 'compressing…';
      try { rec.photo = await compress(file); rec.photoTime = new Date().toISOString(); $('fPhotoPrev').src = rec.photo; $('fPhotoPrev').classList.remove('hidden'); $('fPhotoInfo').textContent = `photo ${Math.round(rec.photo.length * 0.75 / 1024)} KB`; }
      catch (err) { $('fPhotoInfo').textContent = 'could not read photo'; }
    };
    if ($('fPhotoDel')) $('fPhotoDel').onclick = () => { rec.photo = null; $('fPhotoPrev').classList.add('hidden'); $('fPhotoInfo').textContent = 'photo removed'; };
    $('fApn').oninput = () => { rec.apnEdited = true; };
    $('fSave').onclick = () => save(rec);
    if (isNew || rec.apnStatus === 'pending') doLookup();
    setTimeout(() => { if (isNew) $('fName').focus({ preventScroll: true }); }, 50);
  }
  function renderGps() {
    const r = editing; if (!r || !$('fGps')) return;
    const g = r.gps || {};
    $('fGps').innerHTML = `<b>${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}</b> <span class="acc-chip ${accClass(g.accuracyFt)}">${g.manual ? 'placed by hand' : g.accuracyFt != null ? '±' + g.accuracyFt + ' ft' : ''}</span>
      ${r.adjusted ? `<span class="badge warn">pin moved ${r.adjustedFt} ft</span>` : ''}<br><small>Drag the orange pin on the map to fine-tune.</small>`;
  }
  function renderParcel(msg) {
    const r = editing; if (!r || !$('fParcel')) return;
    const p = r.parcel;
    $('fApnSrc').textContent = r.apnSource === 'lookup' ? '(from County GIS — editable)' : r.apnSource === 'manual' ? '(typed)' : '';
    if (msg) { $('fParcel').innerHTML = msg; return; }
    if (p) {
      $('fParcel').innerHTML = `<b>APN ${esc(p.apn)}</b>${p.address ? ` · ${esc(p.address)}` : ''}${p.acreage ? ` · ${p.acreage} ac${p.acreageSrc !== 'assessor' ? ' <small>(GIS area)</small>' : ''}` : ''}
        ${p.owner ? `<br><small>Assessor owner: ${esc(p.owner)}</small>` : ''}`;
    } else if (r.apnStatus === 'none') $('fParcel').innerHTML = '<span class="warnc">No parcel found at this point — type the APN if you know it.</span>';
    else if (r.apnStatus === 'pending') $('fParcel').innerHTML = '<span class="warnc">APN lookup pending (no signal?) — you can save now; it will be looked up later.</span> <button class="small" id="fRetry">Retry</button>';
    if ($('fRetry')) $('fRetry').onclick = doLookup;
  }
  let lookupSeq = 0;
  async function doLookup() {
    const r = editing; if (!r) return;
    const seq = ++lookupSeq;
    renderParcel('<span class="muted">Looking up parcel…</span>');
    try {
      const p = await lookupParcel(r.lat, r.lon);
      if (seq !== lookupSeq || editing !== r) return;
      const typed = $('fApn').value.trim();
      if (r.apnEdited && typed) { r.apn = typed; r.apnSource = 'manual'; }
      applyParcel(r, p);
      if (!(r.apnEdited && typed)) $('fApn').value = r.apn || '';
      showParcel(r.parcel); renderParcel();
    } catch (e) {
      if (seq !== lookupSeq) return;
      r.apnStatus = 'pending'; renderParcel();
    }
  }
  async function save(rec) {
    const name = $('fName').value.trim();
    if (!name) { $('fErr').textContent = 'Customer name is required.'; $('fName').focus(); return; }
    rec.customer = name; rec.phone = $('fPhone').value.trim(); rec.notes = $('fNotes').value.trim();
    const apn = $('fApn').value.trim();
    if (apn !== (rec.apn || '')) { rec.apn = apn; rec.apnSource = apn ? 'manual' : ''; }
    if (rec.apnSource === 'manual') rec.apnStatus = rec.parcel && rec.parcel.apn === rec.apn ? 'ok' : (rec.apnStatus === 'pending' ? 'pending' : 'manual');
    if (!rec.apn && rec.apnStatus !== 'pending' && rec.apnStatus !== 'none') rec.apnStatus = 'pending';
    rec.updated = new Date().toISOString();
    delete rec._new; delete rec.apnEdited;
    try { await Store.put(rec); } catch (e) { $('fErr').textContent = 'Could not save on this device: ' + (e.message || e); return; }
    closeSheet(); await refresh(); toast(`Saved: ${rec.customer}`);
  }
  function compress(file) {
    const P = C.sitePhoto;
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, P.maxPx / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', P.quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
      img.src = url;
    });
  }

  // ---------------------------------------------------------------- 4) My sites list, export/import
  function openList() { openSheet('list', '<div id="listBody"></div>'); renderList(); }
  function renderList() {
    const nPend = sites.filter((s) => s.apnStatus === 'pending').length;
    $('listBody').innerHTML = `<div class="sheet-head"><b>📋 My sites (${sites.length})</b><button class="small" id="lClose">Close</button></div>
      <div class="l-tools"><button class="small" id="lCsv">⬇ CSV</button><button class="small" id="lKml">⬇ KML (Google Earth)</button><button class="small" id="lJson">⬇ Backup</button>
        <label class="small btnlike">⬆ Import backup<input id="lImport" type="file" accept=".json,application/json" hidden></label>
        ${nPend ? `<button class="small" id="lRetry">🔎 Look up ${nPend} pending APN${nPend > 1 ? 's' : ''}</button>` : ''}</div>
      <p class="muted small-note">Stored on this device only (not uploaded). Use Backup / Import to move sites to another phone.</p>
      <div class="l-items">${sites.length ? '' : '<p class="muted">No sites yet. Tap “📌 Tag site” while standing at the proposed well spot.</p>'}</div>`;
    const box = $('listBody').querySelector('.l-items');
    for (const s of sites) {
      const it = document.createElement('div'); it.className = 'l-item';
      it.innerHTML = `<div class="l-main"><b>${esc(s.customer)}</b> <small class="muted">${esc(when(s.created))}</small><br>
        APN <b>${esc(s.apn || '—')}</b> ${apnBadge(s)}${s.address ? `<br><small>${esc(s.address)}</small>` : ''}<br>
        <small class="muted">${s.lat.toFixed(6)}, ${s.lon.toFixed(6)} · ${gpsNote(s)}${s.photo ? ' · 📷' : ''}</small></div><div class="site-actions"></div>`;
      it.querySelector('.l-main').onclick = () => showOnMap(s);
      actionButtons(s, it.querySelector('.site-actions'), false);
      box.appendChild(it);
    }
    $('lClose').onclick = closeSheet;
    $('lCsv').onclick = exportCsv; $('lKml').onclick = exportKml; $('lJson').onclick = exportJson;
    $('lImport').onchange = importJson;
    if ($('lRetry')) $('lRetry').onclick = async () => { await retryPending(); renderList(); };
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  function download(name, type, text) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportCsv() {
    const cols = [['customer', 'Customer'], ['phone', 'Phone'], ['apn', 'APN'], ['apnStatus', 'APN status'], ['address', 'Address'], ['acreage', 'Acres'], ['lat', 'Latitude'], ['lon', 'Longitude'],
      ['accuracyFt', 'GPS accuracy (ft)'], ['adjusted', 'Pin adjusted'], ['adjustedFt', 'Adjusted (ft)'], ['notes', 'Notes'], ['created', 'Tagged'], ['photo', 'Photo'], ['maps', 'Google Maps']];
    const val = (s, k) => ({ accuracyFt: s.gps && s.gps.accuracyFt, acreage: s.parcel && s.parcel.acreage, photo: s.photo ? 'yes' : '', maps: `https://www.google.com/maps/search/?api=1&query=${s.lat.toFixed(6)},${s.lon.toFixed(6)}`,
      lat: s.lat.toFixed(7), lon: s.lon.toFixed(7), adjusted: s.adjusted ? 'yes' : 'no' }[k] ?? s[k]);
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    download(`well-sites_${stamp()}.csv`, 'text/csv', [cols.map((c) => c[1]).join(',')].concat(sites.map((s) => cols.map(([k]) => q(val(s, k))).join(','))).join('\n'));
  }
  function exportKml() {
    const x = (s) => esc(s);
    const pm = sites.map((s) => `  <Placemark>
    <name>${x(s.customer)}</name>
    <description><![CDATA[${summaryText(s).replace(/\]\]>/g, ']] >').replace(/\n/g, '<br>')}]]></description>
    <styleUrl>#site</styleUrl>
    <ExtendedData><Data name="APN"><value>${x(s.apn)}</value></Data><Data name="Phone"><value>${x(s.phone)}</value></Data><Data name="GPS accuracy ft"><value>${s.gps && s.gps.accuracyFt != null ? s.gps.accuracyFt : ''}</value></Data><Data name="Tagged"><value>${x(s.created)}</value></Data></ExtendedData>
    <Point><coordinates>${s.lon.toFixed(7)},${s.lat.toFixed(7)},0</coordinates></Point>
  </Placemark>${s.parcel && s.parcel.rings ? `
  <Placemark><name>${x(s.customer)} — parcel ${x(s.parcel.apn)}</name><styleUrl>#parcel</styleUrl><MultiGeometry>${s.parcel.rings.map((r) => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${r.map(([la, lo]) => `${lo},${la},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`).join('')}</MultiGeometry></Placemark>` : ''}`).join('\n');
    download(`well-sites_${stamp()}.kml`, 'application/vnd.google-earth.kml+xml', `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>Proposed well sites (${stamp()})</name>
  <Style id="site"><IconStyle><color>ff00d7ff</color><scale>1.3</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-stars.png</href></Icon></IconStyle></Style>
  <Style id="parcel"><LineStyle><color>ff15ccfa</color><width>2</width></LineStyle><PolyStyle><color>2015ccfa</color></PolyStyle></Style>
${pm}
</Document></kml>`);
  }
  function exportJson() {
    download(`well-sites-backup_${stamp()}.json`, 'application/json', JSON.stringify({ app: 'wells-nearby', kind: 'sites-backup', version: 1, exported: new Date().toISOString(), sites }, null, 1));
  }
  async function importJson(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const list = Array.isArray(j) ? j : j.sites;
      if (!Array.isArray(list)) throw new Error('not a sites backup');
      let add = 0, upd = 0, skip = 0;
      const have = new Map(sites.map((s) => [s.id, s]));
      for (const s of list) {
        if (!s || !s.id || !Number.isFinite(+s.lat) || !Number.isFinite(+s.lon) || !s.customer) { skip++; continue; }
        s.lat = +s.lat; s.lon = +s.lon;
        const cur = have.get(s.id);
        if (cur && (cur.updated || '') >= (s.updated || '')) { skip++; continue; }
        await Store.put(s); cur ? upd++ : add++;
      }
      await refresh(); renderList();
      toast(`Imported: ${add} new, ${upd} updated, ${skip} skipped`);
    } catch (err) { alert('Import failed: ' + (err.message || err)); }
  }

  // ---------------------------------------------------------------- init
  async function refresh() {
    try { sites = await Store.all(); } catch (e) { sites = []; toast('Device storage unavailable (private mode?)'); }
    $('btnSites').innerHTML = `📋 My sites${sites.length ? ` <span class="count">${sites.length}</span>` : ''}`;
    drawSites();
  }
  $('btnTag').onclick = startTag;
  $('btnTagTop').onclick = startTag;
  $('btnSites').onclick = openList;
  refresh().then(() => { retryPending(); const id = new URLSearchParams(location.search).get('site'); const s = id && sites.find((x) => x.id === id); if (s) showOnMap(s); });
  window.WellsSites = { Store, lookupParcel, refresh, get sites() { return sites; }, startTag, openList, summaryText };
})();
