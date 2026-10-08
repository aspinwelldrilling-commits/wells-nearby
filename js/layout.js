/* Wells Nearby — ✏️ Septic layout: draw a septic system on the satellite map and export a plot plan (PNG / PDF) for the County.
 * Points (well, proposed well, tank, distribution box, seepage pit), lines (leach, sewer, tight, property, other), areas
 * (house, leach field, reserve area, driveway, other; rectangle in 3 taps or any shape), text labels and measurements.
 * Tap a drawing to select it: drag the white dots to reshape, the "+" dots to add a corner, ✥ to move; colour, line style,
 * width and label; every colour/style is a legend entry. Setback rings (50 / 100 / 150 ft) around wells, warnings when a
 * septic item is inside its setback. Property lines can be loaded from the County parcel layer by APN (the same SanGIS
 * parcel query the 🔍 search box uses: only the APN is sent).
 * PRIVATE BY DESIGN: layouts are customer job data and live ONLY on this device (IndexedDB "wells-nearby-layouts"); the plot
 * plan is drawn in this browser (Esri imagery tiles + the drawing on a canvas) and saved / shared from the device. */
(function () {
  'use strict';
  const A = window.WellsApp, LC = window.LayoutCore, K = window.SepticCore;
  if (!A || !A.map || !LC || !K || typeof L === 'undefined') return;
  const map = A.map, KINDS = LC.KINDS;
  const WS = () => window.WellsSites;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (WS() && WS().toast ? WS().toast(m) : console.log(m));
  const r7 = (ll) => [+(+(ll.lat ?? ll[0])).toFixed(7), +(+(ll.lng ?? ll.lon ?? ll[1])).toFixed(7)];
  const M_PER_FT = 1 / LC.FT_PER_M;
  const geomOf = (s) => (KINDS[s.kind] || {}).geom;

  // ------------------------------------------------------------------ device storage (own DB, like My Jobs)
  const DB = 'wells-nearby-layouts', STORE = 'layouts';
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode), q = fn(t.objectStore(STORE));
      t.oncomplete = () => res(q && 'result' in q ? q.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const Store = {
    all: () => tx('readonly', (s) => s.getAll()).then((a) => (a || []).sort((x, y) => (y.updated || '').localeCompare(x.updated || ''))),
    get: (id) => tx('readonly', (s) => s.get(id)),
    put: (v) => tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(v)))),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
  };

  // ------------------------------------------------------------------ state
  let lay = null, active = false, tool = null, draft = [], polyMode = 'rect', sel = null, selV = -1, tab = 'draw', undo = [];
  let saveT = null, lastExport = null, prevZoomLimits = null;

  // ------------------------------------------------------------------ map layers
  map.createPane('layoutPane').style.zIndex = 450;   // above parcels (350), My Jobs drawings (420); below markers / popups
  const renderer = L.canvas({ pane: 'layoutPane', tolerance: 12, padding: 0.3 });
  const ringLayer = L.layerGroup(), shapeLayer = L.layerGroup(), labelLayer = L.layerGroup(), handleLayer = L.layerGroup(), draftLayer = L.layerGroup();
  const LAYERS = [ringLayer, shapeLayer, labelLayer, draftLayer, handleLayer];

  const lum = (hex) => { const h = String(hex).replace('#', ''); const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ink = (c) => (lum(c) > 0.55 ? '#000000' : '#ffffff');
  const dashFor = (st, k = 1) => (st.dash === 'dashed' ? [st.width * 2.6 * k, st.width * 2 * k] : null);
  const TEXT_PX = { s: 12, m: 16, l: 22 };

  /** Small SVG swatch of a legend entry (tool buttons, legend lists). */
  function swatch(e, w = 30, h = 18) {
    if (!e) return '';
    const d = e.dash === 'dashed' ? ` stroke-dasharray="${Math.max(3, e.width * 1.6)} ${Math.max(2, e.width * 1.2)}"` : '';
    const sw = Math.min(6, e.width);
    if (e.sym === 'point') return `<svg class="lo-swsvg" width="${w}" height="${h}" viewBox="0 0 30 18"><circle cx="15" cy="9" r="7" fill="${e.color}" stroke="#334155" stroke-width="1.5"/></svg>`;
    if (e.sym === 'area') return `<svg class="lo-swsvg" width="${w}" height="${h}" viewBox="0 0 30 18"><rect x="3" y="3" width="24" height="12" fill="${e.color}" fill-opacity=".3" stroke="#334155" stroke-width="${sw + 2}" stroke-opacity=".35"/><rect x="3" y="3" width="24" height="12" fill="none" stroke="${e.color}" stroke-width="${sw}"${d}/></svg>`;
    return `<svg class="lo-swsvg" width="${w}" height="${h}" viewBox="0 0 30 18"><line x1="2" y1="9" x2="28" y2="9" stroke="#334155" stroke-opacity=".45" stroke-width="${sw + 2}"/><line x1="2" y1="9" x2="28" y2="9" stroke="${e.color}" stroke-width="${sw}"${d}/></svg>`;
  }
  const RING_ENTRY = (r) => ({ sym: 'line', color: r.color, dash: r.ft === 150 ? 'solid' : 'dashed', width: 2 });

  // ------------------------------------------------------------------ what to label (shared by the map and the plot plan)
  function labelsFor(l, chk) {
    const out = [], sizes = l.opts.sizes !== false;
    for (const s of l.shapes) {
      const g = geomOf(s); if (!s.pts || !s.pts.length) continue;
      if (g === 'line') {
        if (s.kind === 'prop' && sizes) {
          const n = s.pts.length, segs = s.closed ? n : n - 1;
          for (let i = 0; i < segs; i++) { const a = s.pts[i], b = s.pts[(i + 1) % n], ft = LC.segFt(a, b); if (ft >= 20) out.push({ ll: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], text: LC.fmtFt(ft), cls: 'seg' }); }
          if (s.label) out.push({ ll: LC.midAlong(s.pts), text: s.label, cls: 'name' });
        } else {
          const t = [s.label, sizes ? LC.sizeText(s) : ''].filter(Boolean).join(' · ');
          if (t) out.push({ ll: LC.midAlong(s.pts), text: t, cls: 'name' });
        }
      } else if (g === 'poly') {
        const t = [s.label, sizes && s.pts.length >= 3 ? LC.sizeText(s) : ''].filter(Boolean).join('\n');
        if (t) out.push({ ll: LC.centroid(s.pts), text: t, cls: 'name' });
      } else if (g === 'point') {
        if (s.label) out.push({ ll: s.pts[0], text: s.label, cls: 'pt' });
      } else if (g === 'dim' && s.pts.length >= 2) out.push({ ll: LC.midAlong(s.pts), text: LC.sizeText(s), cls: 'dim' });
    }
    if (l.opts.warnings !== false) for (const r of chk.inside) out.push({ ll: r.nearest, text: `⚠ ${r.ftRounded} ft to well — needs ${r.limitFt}`, cls: 'bad', right: r.nearest[1] >= r.wellPt[1] });   // on the side away from the well
    if (l.opts.rings) for (const w of chk.wells) for (const r of K.RINGS) out.push({ ll: K.projector(w.lat, w.lon).inv(0, r.ft * M_PER_FT), text: `${r.ft} ft`, cls: 'ring', color: r.color });
    return out;
  }
  const drawOrder = { poly: 0, line: 1, dim: 2, point: 3, text: 4 };
  const sorted = (l) => l.shapes.slice().sort((a, b) => (drawOrder[geomOf(a)] ?? 9) - (drawOrder[geomOf(b)] ?? 9));

  // ------------------------------------------------------------------ map rendering
  function render(o = {}) {
    for (const g of LAYERS) if (g !== handleLayer || !o.keepHandles) g.clearLayers();
    if (!lay || !active) return;
    const chk = LC.setbackChecks(lay), bad = new Map(chk.inside.map((r) => [r.shape.id, r]));
    if (lay.opts.rings) for (const w of chk.wells) for (const r of K.RINGS) {
      L.circle([w.lat, w.lon], { renderer, radius: r.ft * M_PER_FT, color: r.color, weight: 2.5, opacity: 0.95, dashArray: r.ft === 150 ? null : '7 5', fill: false, interactive: false }).addTo(ringLayer);
    }
    for (const s of sorted(lay)) drawShape(s, lay.opts.warnings !== false && bad.get(s.id));
    if (lay.opts.warnings !== false) for (const r of chk.inside) L.polyline([r.wellPt, r.nearest], { renderer, color: '#dc2626', weight: 2.5, dashArray: '4 5', interactive: false }).addTo(ringLayer);
    const sr = sel && chk.rows.find((r) => r.shape.id === sel && r.status !== 'inside' && r.nearest);
    if (sr) {
      L.polyline([sr.wellPt, sr.nearest], { renderer, color: '#22c55e', weight: 2.5, dashArray: '4 5', interactive: false }).addTo(ringLayer);
      label([(sr.wellPt[0] + sr.nearest[0]) / 2, (sr.wellPt[1] + sr.nearest[1]) / 2], `${sr.ftRounded} ft to well`, 'ok');
    }
    for (const b of labelsFor(lay, chk)) label(b.ll, b.text, b.cls === 'bad' ? (b.right ? 'bad lo-badr' : 'bad lo-badl') : b.cls, b.color);
    renderDraft();
    if (!o.keepHandles) renderHandles();
    renderMapLegend(chk);
  }
  function label(ll, text, cls, color) {
    if (!ll) return;
    const html = `<span class="lo-lbl lo-${cls}"${color ? ` style="border-color:${color}"` : ''}>${esc(text).replace(/\n/g, '<br>')}</span>`;
    L.marker(ll, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'lo-lblw', html, iconSize: [0, 0] }) }).addTo(labelLayer);
  }
  function drawShape(s, badRow) {
    const g = geomOf(s), isSel = s.id === sel;
    if (g === 'text') {
      const c = s.color || '#ffffff';
      const m = L.marker(s.pts[0], { keyboard: false, zIndexOffset: 500, icon: L.divIcon({ className: 'lo-own lo-textw', iconSize: [0, 0],
        html: `<div class="lo-text${isSel ? ' sel' : ''}${lum(c) > 0.55 ? ' light' : ' dark'}" style="color:${c};font-size:${TEXT_PX[s.size || 'm']}px">${esc(s.text || 'Text')}</div>` }) });
      m.on('click', (e) => onShapeTap(s, e)); m.addTo(shapeLayer); return;
    }
    if (g === 'point') {
      const st = LC.styleOf(lay, s);
      const m = L.marker(s.pts[0], { keyboard: false, zIndexOffset: 600, title: KINDS[s.kind].label, icon: L.divIcon({ className: 'lo-own', iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div class="lo-pt${badRow ? ' bad' : ''}${isSel ? ' sel' : ''}" style="background:${st.color};color:${ink(st.color)}">${KINDS[s.kind].code}</div>` }) });
      m.on('click', (e) => onShapeTap(s, e)); m.addTo(shapeLayer); return;
    }
    if (g === 'dim') {
      if (s.pts.length < 2) return;
      if (isSel) L.polyline(s.pts, { renderer, color: '#22d3ee', weight: 10, opacity: 0.55, interactive: false }).addTo(shapeLayer);
      L.polyline(s.pts, { renderer, color: '#000', weight: 4, opacity: 0.6, interactive: false }).addTo(shapeLayer);
      L.polyline(s.pts, { renderer, color: '#ffffff', weight: 2 }).on('click', (e) => onShapeTap(s, e)).addTo(shapeLayer);
      s.pts.forEach((q) => L.circleMarker(q, { renderer, radius: 3.5, color: '#000', weight: 1, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(shapeLayer));
      return;
    }
    const st = LC.styleOf(lay, s), closed = g === 'poly' || s.closed;
    const path = closed && s.pts.length > 2 ? s.pts.concat([s.pts[0]]) : s.pts;
    const dash = dashFor(st);
    if (badRow) L.polyline(path, { renderer, color: '#dc2626', weight: st.width + 12, opacity: 0.45, interactive: false }).addTo(shapeLayer);
    if (isSel) L.polyline(path, { renderer, color: '#22d3ee', weight: st.width + 8, opacity: 0.55, interactive: false }).addTo(shapeLayer);
    L.polyline(path, { renderer, color: lum(st.color) > 0.55 ? '#000000' : '#ffffff', weight: st.width + 2, opacity: 0.4, interactive: false }).addTo(shapeLayer);
    const opt = { renderer, color: st.color, weight: st.width, opacity: 1, dashArray: dash ? dash.join(' ') : null, lineCap: dash ? 'butt' : 'round' };
    const p = g === 'poly' && s.pts.length > 2 ? L.polygon(s.pts, { ...opt, fillColor: st.color, fillOpacity: 0.18 }) : L.polyline(path, opt);
    p.on('click', (e) => onShapeTap(s, e)); p.addTo(shapeLayer);
  }
  function renderDraft() {
    draftLayer.clearLayers();
    if (!tool || !draft.length) return;
    const k = KINDS[tool], e = k.legend ? LC.entryOf(lay, k.legend) || LC.DEFAULT_LEGEND.find((x) => x.id === k.legend) : { color: '#ffffff' };
    const col = e.color;
    let pts = draft;
    if (k.geom === 'poly' && polyMode === 'poly' && draft.length > 2) pts = draft.concat([draft[0]]);
    if (pts.length > 1) {
      L.polyline(pts, { renderer, color: '#000', weight: 6, opacity: 0.45, interactive: false }).addTo(draftLayer);
      L.polyline(pts, { renderer, color: col, weight: 3, dashArray: '6 6', interactive: false }).addTo(draftLayer);
    }
    draft.forEach((p, i) => L.circleMarker(p, { renderer, radius: i === 0 ? 8 : 6, color: '#fff', weight: 2.5, fillColor: i === 0 ? '#0f172a' : col, fillOpacity: 1, interactive: false }).addTo(draftLayer));
  }
  let rdT = null;
  const renderSoon = () => { if (rdT) return; rdT = requestAnimationFrame(() => { rdT = null; render({ keepHandles: true }); }); };

  // ------------------------------------------------------------------ selection + handles
  const shapeById = (id) => (lay ? lay.shapes.find((s) => s.id === id) : null);
  function handleIcon(cls, html = '') { return L.divIcon({ className: 'lo-own ' + cls, html: `<div>${html}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] }); }
  function renderHandles() {
    handleLayer.clearLayers();
    const s = shapeById(sel); if (!s || !active) return;
    const g = geomOf(s);
    s.pts.forEach((p, i) => {
      const h = L.marker(p, { draggable: true, keyboard: false, zIndexOffset: 5000, icon: handleIcon('lo-h' + (i === selV ? ' on' : '')) }).addTo(handleLayer);
      h.on('dragstart', pushUndo);
      h.on('drag', () => { s.pts[i] = r7(h.getLatLng()); renderSoon(); });
      h.on('dragend', () => { selV = g === 'point' || g === 'text' ? -1 : i; changed(); });
      h.on('click', (e) => { L.DomEvent.stopPropagation(e); selV = selV === i ? -1 : i; renderHandles(); renderSheet(); });
    });
    if (g === 'line' || g === 'poly') {
      const n = s.pts.length, segs = g === 'poly' || s.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = s.pts[i], b = s.pts[(i + 1) % n];
        const h = L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { draggable: true, keyboard: false, zIndexOffset: 4500, icon: handleIcon('lo-hm', '+') }).addTo(handleLayer);
        let idx = -1;
        h.on('dragstart', () => { pushUndo(); idx = i + 1; s.pts.splice(idx, 0, r7(h.getLatLng())); });
        h.on('drag', () => { if (idx >= 0) { s.pts[idx] = r7(h.getLatLng()); renderSoon(); } });
        h.on('dragend', () => { selV = idx; changed(); });
        h.on('click', (e) => L.DomEvent.stopPropagation(e));
      }
    }
    if ((g === 'line' || g === 'poly' || g === 'dim') && s.pts.length > 1) {
      const c = g === 'poly' && s.pts.length > 2 ? LC.centroid(s.pts) : LC.midAlong(s.pts);
      const mv = L.marker(c, { draggable: true, keyboard: false, zIndexOffset: 5200, title: 'Move', icon: handleIcon('lo-hmove', '✥') }).addTo(handleLayer);
      let start = null, orig = null;
      mv.on('dragstart', () => { pushUndo(); start = mv.getLatLng(); orig = s.pts.map((p) => p.slice()); });
      mv.on('drag', () => { const ll = mv.getLatLng(), dy = ll.lat - start.lat, dx = ll.lng - start.lng; s.pts = orig.map((p) => [+(p[0] + dy).toFixed(7), +(p[1] + dx).toFixed(7)]); renderSoon(); });
      mv.on('dragend', () => changed());
      mv.on('click', (e) => L.DomEvent.stopPropagation(e));
    }
  }
  function select(id, o = {}) {
    if (sel && sel !== id) dropEmptyText();
    sel = id; selV = -1;
    render(); renderSheet();
    const s = shapeById(id);
    if (s && o.zoom) { if (s.pts.length === 1) map.panTo(s.pts[0]); else map.fitBounds(L.latLngBounds(s.pts).pad(0.3), { maxZoom: 20 }); }
    if (s && o.focusText) setTimeout(() => { const i = $('loText'); if (i) { i.focus(); i.select(); } }, 60);
  }
  function dropEmptyText() {
    const s = shapeById(sel);
    if (s && s.kind === 'text' && !String(s.text || '').trim()) { lay.shapes = lay.shapes.filter((x) => x !== s); scheduleSave(); }
  }
  function onShapeTap(s, e) {
    if (!active) return;
    L.DomEvent.stopPropagation(e);
    if (tool) {   // drawing: a tap on a drawn point snaps to it, a tap on a line / area adds a point right there
      const g = geomOf(s);
      return addPoint(g === 'point' || g === 'text' ? s.pts[0] : [e.latlng.lat, e.latlng.lng]);
    }
    select(s.id);
  }
  map.on('click', (e) => {
    if (!active) return;
    if (tool) return addPoint([e.latlng.lat, e.latlng.lng]);
    if (sel) select(null);
  });

  // ------------------------------------------------------------------ drawing
  function startTool(kind) {
    if (!lay || !KINDS[kind]) return;
    dropEmptyText();
    tool = kind; draft = []; sel = null; selV = -1; legPeek = false;
    polyMode = KINDS[kind].rect ? 'rect' : 'poly';
    map.getContainer().classList.add('lo-tool');
    render(); renderSheet();
  }
  function stopTool() { tool = null; draft = []; map.getContainer().classList.remove('lo-tool'); }
  function addPoint(p) {
    const k = KINDS[tool]; if (!k) return;
    p = r7(p);
    if (k.geom === 'point') return addShape({ kind: tool, pts: [p], legendId: LC.ensureKindEntry(lay, tool) });
    if (k.geom === 'text') return addShape({ kind: 'text', pts: [p], text: 'Text', size: 'm', color: '#ffffff' }, { focusText: true });
    if (draft.length) {
      const px = map.latLngToContainerPoint(p), near = (q) => map.latLngToContainerPoint(q).distanceTo(px) < 20;
      if (k.geom === 'poly' && polyMode === 'poly' && draft.length >= 3 && near(draft[0])) return finishDraft();
      if (k.geom === 'line' && draft.length >= 2 && near(draft[draft.length - 1])) return finishDraft();
      if (near(draft[draft.length - 1])) return;   // a double tap on the same spot
    }
    draft.push(p);
    if (k.geom === 'dim' && draft.length === 2) return finishDraft();
    if (k.geom === 'poly' && polyMode === 'rect' && draft.length === 3) return finishDraft();
    renderDraft(); renderSheet();
  }
  function finishDraft() {
    const k = KINDS[tool]; if (!k) return;
    let pts = draft.slice();
    if (k.geom === 'poly' && polyMode === 'rect') { if (pts.length < 3) return toast('Tap 2 corners along one side, then the opposite side'); pts = LC.rectFrom3(pts[0], pts[1], pts[2]); }
    if ((k.geom === 'line' || k.geom === 'dim') && pts.length < 2) return toast('Tap at least 2 points');
    if (k.geom === 'poly' && pts.length < 3) return toast('Tap at least 3 corners');
    const s = { kind: tool, pts };
    if (k.legend) s.legendId = LC.ensureKindEntry(lay, tool);
    addShape(s);
  }
  function addShape(s, o = {}) {
    pushUndo();
    s.id = LC.newId('sh'); lay.shapes.push(s);
    const kind = s.kind;
    stopTool(); sel = s.id; selV = -1;
    changed();
    if (o.focusText) setTimeout(() => { const i = $('loText'); if (i) { i.focus(); i.select(); } }, 60);
    const r = LC.setbackChecks(lay).rows.find((x) => x.shape === s);
    if (r && r.status === 'inside') toast(LC.checkText(r));
    else if (r && r.status !== 'nowell') toast(`${KINDS[kind].label}: ${r.ftRounded} ft from the well (needs ${r.limitFt})`);
    else if (KINDS[kind].source && lay.opts.rings) toast('Setback rings: 50 / 100 / 150 ft');
    else if (kind === 'dim') toast(`Distance: ${LC.sizeText(s)}`);
  }

  // ------------------------------------------------------------------ undo + save
  function pushUndo() { if (!lay) return; undo.push(JSON.stringify({ shapes: lay.shapes, legend: lay.legend })); if (undo.length > 80) undo.shift(); }
  function doUndo() {
    if (tool && draft.length) { draft.pop(); renderDraft(); renderSheet(); return; }
    const last = undo.pop(); if (!last) return toast('Nothing to undo');
    const o = JSON.parse(last); lay.shapes = o.shapes; lay.legend = o.legend;
    if (sel && !shapeById(sel)) sel = null;
    selV = -1; changed();
  }
  function changed() { if (!lay) return; lay.updated = new Date().toISOString(); scheduleSave(); render(); renderSheet(); }
  function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(saveNow, 300); }
  async function saveNow() {
    clearTimeout(saveT); saveT = null;
    if (!lay) return;
    try { await Store.put(lay); } catch (e) { toast('Could not save on this device: ' + (e.message || e)); }
  }

  // ------------------------------------------------------------------ on-map legend
  const LegCtl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() { const d = L.DomUtil.create('div', 'lo-mapleg'); L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d; },
  });
  const legCtl = new LegCtl();
  let legOpen = true, legPeek = false;
  function renderMapLegend(chk) {
    const d = legCtl.getContainer(); if (!d || !lay) return;
    const used = LC.usedLegend(lay), rings = lay.opts.rings && chk.wells.length;
    if (!used.length && !rings) { d.innerHTML = ''; d.classList.add('empty'); return; }
    d.classList.remove('empty');
    const open = tool ? legPeek : legOpen;   // folded while drawing so it never eats a tap
    d.innerHTML = `<button type="button" class="lo-legbtn">Legend ${open ? '▾' : '▸'}</button>${open ? `<div class="lo-legrows">${used.map((e) => `<div>${swatch(e, 24, 14)}<span>${esc(e.label)}</span></div>`).join('')}${rings ? K.RINGS.map((r) => `<div>${swatch(RING_ENTRY(r), 24, 14)}<span>${r.ft} ft well setback</span></div>`).join('') : ''}</div>` : ''}`;
    d.querySelector('.lo-legbtn').onclick = () => { if (tool) legPeek = !open; else legOpen = !open; renderMapLegend(LC.setbackChecks(lay)); };
  }

  // ------------------------------------------------------------------ enter / leave drawing mode
  function zoomLimitsUp() {
    if (prevZoomLimits) return;
    prevZoomLimits = { mapMax: map.options.maxZoom, layers: [] };
    const seen = new Set();
    const fix = (l) => {
      if (!(l instanceof L.TileLayer) || seen.has(l) || !/arcgisonline/.test(l._url || '')) return;
      seen.add(l); prevZoomLimits.layers.push([l, l.options.maxZoom, l.options.maxNativeZoom]);
      l.options.maxNativeZoom = Math.min(19, l.options.maxNativeZoom || l.options.maxZoom || 19); l.options.maxZoom = 21;
    };
    map.eachLayer(fix);
    if (A.layersCtl && A.layersCtl._layers) A.layersCtl._layers.forEach((o) => { if (o.layer instanceof L.LayerGroup) o.layer.eachLayer(fix); else fix(o.layer); });
    map.setMaxZoom(21);   // zoom past the imagery (19) to place a tank or a corner precisely
  }
  function zoomLimitsDown() {
    if (!prevZoomLimits) return;
    for (const [l, mz, mn] of prevZoomLimits.layers) { l.options.maxZoom = mz; l.options.maxNativeZoom = mn; }
    if (map.getZoom() > 19) map.setZoom(19, { animate: false });
    map.setMaxZoom(prevZoomLimits.mapMax);
    prevZoomLimits = null;
  }
  function enterMode() {
    if (active) return;
    active = true;
    document.body.classList.add('layout-open');
    map.getContainer().classList.add('lo-mode');
    A.state.mapTool = true; map.doubleClickZoom.disable(); map.closePopup();
    LAYERS.forEach((g) => g.addTo(map));
    legCtl.addTo(map);
    zoomLimitsUp();
    map.invalidateSize({ pan: false });
  }
  function leaveMode() {
    if (!active) return;
    dropEmptyText();
    saveNow();
    active = false; stopTool(); sel = null; selV = -1;
    LAYERS.forEach((g) => { g.clearLayers(); map.removeLayer(g); });
    if (map.hasLayer(renderer)) map.removeLayer(renderer);
    legCtl.remove();
    document.body.classList.remove('layout-open');
    map.getContainer().classList.remove('lo-mode', 'lo-tool');
    $('sheet').classList.remove('lo-sheet');
    A.state.mapTool = false; map.doubleClickZoom.enable();
    zoomLimitsDown();
    map.invalidateSize({ pan: false });
    lay = null; undo = [];
  }
  map.on('moveend', () => { if (active && lay) { const c = map.getCenter(); lay.view = { lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), z: map.getZoom() }; scheduleSave(); } });

  // ------------------------------------------------------------------ the sheet: editor
  function openEditor(l, o = {}) {
    WS().openSheet('layout', `<div class="sheet-head lo-head"><b id="loTitle"></b><span class="lo-hbtns"><button type="button" class="small" id="loUndo" title="Undo">↶ Undo</button><button type="button" class="small" id="loList" title="All layouts">☰ Layouts</button><button type="button" class="small good" id="loDone">Done</button></span></div>
      <div id="loSum"></div>
      <div class="lo-tabs" id="loTabs"><button type="button" data-t="draw">✏️ Draw</button><button type="button" data-t="items">📋 Items</button><button type="button" data-t="legend">🎨 Legend</button><button type="button" data-t="plan">🖨 Plan</button></div>
      <div id="loBody"></div>`);
    $('sheet').classList.add('lo-sheet');
    lay = l; undo = []; sel = null; selV = -1; tab = o.tab || 'draw'; stopTool();
    enterMode();
    const all = l.shapes.flatMap((s) => s.pts);
    if (o.fit && all.length) map.fitBounds(L.latLngBounds(all).pad(0.25), { maxZoom: 20, animate: false });
    else if (l.view) map.setView([l.view.lat, l.view.lon], l.view.z || 19, { animate: false });
    else if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.25), { maxZoom: 20, animate: false });
    else if (map.getZoom() < 18) map.setZoom(18, { animate: false });
    $('loUndo').onclick = doUndo;
    $('loDone').onclick = () => WS().closeSheet();
    $('loList').onclick = () => openList();
    $('loTabs').querySelectorAll('button').forEach((b) => (b.onclick = () => { dropEmptyText(); stopTool(); sel = null; tab = b.dataset.t; render(); renderSheet(); }));
    render(); renderSheet();
    saveNow();
  }
  function renderSheet() {
    if (!lay || !$('loBody')) return;
    $('loTitle').textContent = '✏️ ' + (lay.name || 'Septic layout');
    $('loTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', !tool && !sel && b.dataset.t === tab));
    renderSum();
    const body = $('loBody');
    if (tool) return renderInstr(body);
    if (sel && shapeById(sel)) return renderSel(body);
    ({ draw: renderDrawTab, items: renderItemsTab, legend: renderLegendTab, plan: renderPlanTab }[tab] || renderDrawTab)(body);
  }
  function renderSum() {
    const chk = LC.setbackChecks(lay), el = $('loSum'), septic = chk.rows.length;
    let h = '';
    if (chk.inside.length) h = `<div class="sb-sum bad">⚠ ${chk.inside.length} setback problem${chk.inside.length > 1 ? 's' : ''}: ${chk.inside.map((r) => `${esc(KINDS[r.shape.kind].label)} ${r.ftRounded} ft (needs ${r.limitFt})`).join('; ')}</div>`;
    else if (septic && !chk.wells.length) h = '<div class="sb-sum near">Add a well or proposed well to check setbacks.</div>';
    else if (chk.near.length) h = `<div class="sb-sum near">📏 ${chk.near.length} item${chk.near.length > 1 ? 's' : ''} just outside a setback — check with a tape</div>`;
    else if (septic) h = `<div class="sb-sum ok">✓ ${septic} septic item${septic > 1 ? 's' : ''} clear of well setbacks</div>`;
    el.innerHTML = h;
  }
  function toolBtn(k) {
    const e = KINDS[k].legend ? (LC.entryOf(lay, KINDS[k].legend) || LC.DEFAULT_LEGEND.find((x) => x.id === KINDS[k].legend)) : null;
    return `<button type="button" class="lo-tool" data-k="${k}">${e ? swatch(e, 26, 16) : `<span class="lo-ticon">${KINDS[k].icon}</span>`}<span>${esc(KINDS[k].label)}</span>${KINDS[k].setbackFt ? `<small>${KINDS[k].setbackFt} ft</small>` : ''}</button>`;
  }
  function renderDrawTab(body) {
    const grp = (t, ks) => `<div class="lo-grp">${t}</div><div class="lo-tools">${ks.map(toolBtn).join('')}</div>`;
    body.innerHTML = `${lay.shapes.length ? '' : '<div class="lo-hint">Pick something to draw, then tap the map. Pan and zoom with your fingers as usual. Tip: start with <b>▦ Parcel lines</b> and the well.</div>'}
      ${grp('Points', ['well', 'pwell', 'tank', 'dbox', 'pit'])}${grp('Lines', ['leach', 'sewer', 'tight', 'prop', 'line'])}${grp('Areas', ['house', 'field', 'reserve', 'drive', 'area'])}
      <div class="lo-grp">Other</div><div class="lo-tools">${toolBtn('text')}${toolBtn('dim')}<button type="button" class="lo-tool" id="loParcelBtn"><span class="lo-ticon">▦</span><span>Parcel lines from APN</span></button></div>
      <div class="lo-toggles"><label><input type="checkbox" id="loRings" ${lay.opts.rings ? 'checked' : ''}> ◎ Setback rings</label><label><input type="checkbox" id="loSizes" ${lay.opts.sizes !== false ? 'checked' : ''}> 📐 Lengths &amp; areas</label></div>`;
    body.querySelectorAll('.lo-tool[data-k]').forEach((b) => (b.onclick = () => startTool(b.dataset.k)));
    $('loParcelBtn').onclick = () => { tab = 'plan'; renderSheet(); setTimeout(() => { const i = $('loApn'); if (i) { i.scrollIntoView({ block: 'center' }); if (!i.value) i.focus(); } }, 50); };
    $('loRings').onchange = (e) => { lay.opts.rings = e.target.checked; scheduleSave(); render(); };
    $('loSizes').onchange = (e) => { lay.opts.sizes = e.target.checked; scheduleSave(); render(); };
  }
  function renderInstr(body) {
    const k = KINDS[tool], n = draft.length, nm = k.label.toLowerCase();
    let t, btns = '';
    if (k.geom === 'point') t = `Tap the map where the <b>${esc(nm)}</b> is.`;
    else if (k.geom === 'text') t = 'Tap the map where the text goes.';
    else if (k.geom === 'dim') t = n ? 'Now tap the end point.' : 'Tap the start point, then the end point — the distance shows in feet.';
    else if (k.geom === 'line') {
      t = `Tap each point along the <b>${esc(nm)}</b>. Tap the last point again or ✓ Finish when done.${n > 1 ? ` <span class="lo-live">${n} points · ${LC.fmtFt(LC.lengthFt(draft))}</span>` : ''}`;
      btns = `<button type="button" class="small good" id="loFinish" ${n >= 2 ? '' : 'disabled'}>✓ Finish</button>`;
    } else {
      t = polyMode === 'rect' ? `<b>${esc(k.label)}</b>: tap 2 corners along one side, then tap anywhere on the opposite side.${n ? ` <span class="lo-live">${n} of 3</span>` : ''}`
        : `<b>${esc(k.label)}</b>: tap each corner; tap the first corner (dark dot) or ✓ Finish to close.${n > 2 ? ` <span class="lo-live">${n} corners · ${LC.fmtSqFt(LC.areaSqFt(draft))}</span>` : ''}`;
      if (polyMode === 'poly') btns = `<button type="button" class="small good" id="loFinish" ${n >= 3 ? '' : 'disabled'}>✓ Finish</button>`;
    }
    body.innerHTML = `<div class="sb-instr">${t}
      ${k.geom === 'poly' ? `<div class="seg lo-seg" id="loPolyMode"><button type="button" data-m="rect" class="${polyMode === 'rect' ? 'on' : ''}">▭ Rectangle</button><button type="button" data-m="poly" class="${polyMode === 'poly' ? 'on' : ''}">⬠ Any shape</button></div>` : ''}
      <div class="sb-row">${n ? '<button type="button" class="small" id="loUndoPt">↶ Undo point</button>' : ''}${btns}<button type="button" class="small" id="loCancel">Cancel</button></div></div>`;
    $('loCancel').onclick = () => { stopTool(); render(); renderSheet(); };
    if ($('loUndoPt')) $('loUndoPt').onclick = () => { draft.pop(); renderDraft(); renderSheet(); };
    if ($('loFinish')) $('loFinish').onclick = finishDraft;
    if ($('loPolyMode')) $('loPolyMode').querySelectorAll('button').forEach((b) => (b.onclick = () => { polyMode = b.dataset.m; draft = []; renderDraft(); renderSheet(); }));
  }
  function palette(cur, id) {
    return `<div class="lo-pal" id="${id}">${LC.PALETTE.map((p) => `<button type="button" data-c="${p.c}" class="${p.c === cur ? 'on' : ''}" style="background:${p.c}" title="${p.n}" aria-label="${p.n}"></button>`).join('')}</div>`;
  }
  function styleControls(st, sym, pre) {
    return `<div class="lo-sub">Colour</div>${palette(st.color, pre + 'Pal')}
      ${sym !== 'point' ? `<div class="lo-stylerow"><div class="seg lo-seg" id="${pre}Dash"><button type="button" data-d="solid" class="${st.dash !== 'dashed' ? 'on' : ''}">━ Solid</button><button type="button" data-d="dashed" class="${st.dash === 'dashed' ? 'on' : ''}">┅ Dashed</button></div>
        <div class="seg lo-seg" id="${pre}Width">${LC.WIDTHS.map((w) => `<button type="button" data-w="${w}" class="${+st.width === w ? 'on' : ''}" aria-label="width ${w}"><i style="height:${w}px"></i></button>`).join('')}</div></div>` : ''}`;
  }
  function bindStyle(pre, fn) {
    const pal = $(pre + 'Pal'); if (pal) pal.querySelectorAll('button').forEach((b) => (b.onclick = () => fn({ color: b.dataset.c })));
    const d = $(pre + 'Dash'); if (d) d.querySelectorAll('button').forEach((b) => (b.onclick = () => fn({ dash: b.dataset.d })));
    const w = $(pre + 'Width'); if (w) w.querySelectorAll('button').forEach((b) => (b.onclick = () => fn({ width: +b.dataset.w })));
  }
  function renderSel(body) {
    const s = shapeById(sel), k = KINDS[s.kind], g = k.geom, sym = LC.symOf(s.kind);
    const chk = LC.setbackChecks(lay).rows.find((r) => r.shape === s);
    const size = LC.sizeText(s);
    const canDelV = selV >= 0 && ((g === 'line' && s.pts.length > 2) || (g === 'poly' && s.pts.length > 3));
    let h = `<div class="lo-selhead"><b>${k.icon} ${esc(k.label)}</b>${size ? ` <span class="lo-live">${esc(size)}${g === 'line' && s.closed ? ' around' : ''}</span>` : ''}<button type="button" class="small good" id="loSelDone">✓ Done</button></div>`;
    if (chk) h += `<div class="sb-item ${chk.status === 'nowell' ? 'near' : chk.status}"><div class="sb-text">${esc(LC.checkText(chk))}</div></div>`;
    if (g === 'text') {
      h += `<label>Text<input type="text" id="loText" value="${esc(s.text || '')}" maxlength="200"></label>
        <div class="lo-stylerow"><div class="seg lo-seg" id="loTSize">${['s', 'm', 'l'].map((z) => `<button type="button" data-z="${z}" class="${(s.size || 'm') === z ? 'on' : ''}">${{ s: 'Small', m: 'Medium', l: 'Large' }[z]}</button>`).join('')}</div></div>
        <div class="lo-sub">Colour</div>${palette(s.color || '#ffffff', 'loSelPal')}`;
    } else if (g !== 'dim') {
      const st = LC.styleOf(lay, s), n = LC.usage(lay, st.id);
      const same = Object.keys(KINDS).filter((x) => KINDS[x].geom === g);
      h += `<label>Label <small>(optional, shows on the plan)</small><input type="text" id="loLbl" value="${esc(s.label || '')}" maxlength="120" placeholder="${g === 'point' ? 'e.g. 1,500 gal tank' : g === 'line' ? 'e.g. 3 × 60 ft leach lines' : 'e.g. Proposed house'}"></label>
        ${styleControls(st, sym, 'loSel')}
        <label>Legend name <small>(${n} item${n === 1 ? '' : 's'} use it)</small><input type="text" id="loLegName" value="${esc(st.label)}" maxlength="80"></label>
        <label>What is it?<select id="loKind">${same.map((x) => `<option value="${x}" ${x === s.kind ? 'selected' : ''}>${esc(KINDS[x].label)}</option>`).join('')}</select></label>
        ${g === 'line' ? `<label class="lo-chk"><input type="checkbox" id="loClosed" ${s.closed ? 'checked' : ''}> Closed loop (joins the last point to the first)</label>` : ''}`;
    }
    h += `<div class="sb-row">${canDelV ? `<button type="button" class="small" id="loDelV">✕ Remove corner ${selV + 1}</button>` : ''}<button type="button" class="small" id="loZoom">🔍 Zoom to it</button><button type="button" class="small danger" id="loDel">🗑 Delete</button></div>
      <p class="small-note muted">${g === 'point' || g === 'text' ? 'Drag the white dot to move it.' : 'Drag the white dots to reshape, the “+” dots to add a corner, ✥ to move it all. Tap a white dot, then “Remove corner” to delete that corner.'}</p>`;
    body.innerHTML = h;
    $('loSelDone').onclick = () => select(null);
    $('loDel').onclick = () => { pushUndo(); lay.shapes = lay.shapes.filter((x) => x !== s); LC.pruneLegend(lay); sel = null; changed(); toast(`${k.label} deleted — ↶ Undo brings it back`); };
    $('loZoom').onclick = () => select(s.id, { zoom: true });
    if ($('loDelV')) $('loDelV').onclick = () => { pushUndo(); s.pts.splice(selV, 1); selV = -1; changed(); };
    if (g === 'text') {
      $('loText').oninput = (e) => { s.text = e.target.value; lay.updated = new Date().toISOString(); scheduleSave(); render(); };
      $('loTSize').querySelectorAll('button').forEach((b) => (b.onclick = () => { pushUndo(); s.size = b.dataset.z; changed(); }));
      bindStyle('loSel', (w) => { pushUndo(); s.color = w.color; changed(); });
    } else if (g !== 'dim') {
      $('loLbl').oninput = (e) => { s.label = e.target.value; lay.updated = new Date().toISOString(); scheduleSave(); render(); };
      bindStyle('loSel', (w) => { pushUndo(); LC.restyle(lay, s, w); changed(); });
      $('loLegName').oninput = (e) => { const en = LC.entryOf(lay, LC.styleOf(lay, s).id); if (en) { en.label = e.target.value; delete en.auto; scheduleSave(); render(); } };
      $('loKind').onchange = (e) => {
        pushUndo();
        const old = s.kind; s.kind = e.target.value;
        if (!s.legendId || s.legendId === KINDS[old].legend) s.legendId = LC.ensureKindEntry(lay, s.kind);
        LC.pruneLegend(lay); changed();
      };
      if ($('loClosed')) $('loClosed').onchange = (e) => { pushUndo(); if (e.target.checked) s.closed = true; else delete s.closed; changed(); };
    }
  }
  function renderItemsTab(body) {
    const chk = LC.setbackChecks(lay), by = new Map(chk.rows.map((r) => [r.shape.id, r]));
    if (!lay.shapes.length) { body.innerHTML = '<div class="lo-hint">Nothing drawn yet. Use ✏️ Draw.</div>'; return; }
    body.innerHTML = `<div class="lo-items">${lay.shapes.map((s) => {
      const k = KINDS[s.kind], r = by.get(s.id), g = k.geom;
      const sw = LC.symOf(s.kind) ? swatch(LC.styleOf(lay, s), 26, 16) : `<span class="lo-ticon">${k.icon}</span>`;
      const name = g === 'text' ? `“${esc(s.text || '')}”` : `${esc(k.label)}${s.label ? ` <i>${esc(s.label)}</i>` : ''}`;
      return `<button type="button" class="lo-item ${r ? (r.status === 'nowell' ? 'near' : r.status) : ''}" data-id="${esc(s.id)}">${sw}<span><b>${name}</b> <small>${esc(LC.sizeText(s))}</small>${r ? `<br><small class="lo-chk-${r.status}">${esc(LC.checkText(r))}</small>` : ''}</span></button>`;
    }).join('')}</div>`;
    body.querySelectorAll('.lo-item').forEach((b) => (b.onclick = () => select(b.dataset.id, { zoom: true })));
  }
  function renderLegendTab(body) {
    body.innerHTML = `<p class="small-note muted">Each colour + line style is one legend entry. Rename or restyle an entry here and every drawing that uses it changes too. Only entries in use print on the plot plan.</p>
      <div id="loLegList">${lay.legend.map((e) => { const n = LC.usage(lay, e.id); return `<div class="lo-leg" data-id="${esc(e.id)}">
        <div class="lo-legrow"><button type="button" class="lo-legsw" title="Change colour / style">${swatch(e)}</button><input type="text" class="lo-legname" value="${esc(e.label)}" maxlength="80" aria-label="Legend label">
          <small class="muted">${n ? `${n} used` : 'unused'}</small><button type="button" class="small danger lo-legdel" title="Remove entry" aria-label="Remove entry">🗑</button></div>
        <div class="lo-legedit hidden">${styleControls(e, e.sym, 'leg-' + e.id)}</div></div>`; }).join('')}</div>
      <div class="sb-row"><select id="loLegSym" aria-label="Entry type"><option value="line">Line</option><option value="area">Area</option><option value="point">Point</option></select><button type="button" class="small" id="loLegAdd">＋ Add entry</button><button type="button" class="small" id="loLegReset">↺ Add missing defaults</button></div>`;
    body.querySelectorAll('.lo-leg').forEach((row) => {
      const e = LC.entryOf(lay, row.dataset.id);
      row.querySelector('.lo-legname').oninput = (ev) => { e.label = ev.target.value; delete e.auto; scheduleSave(); render(); };
      row.querySelector('.lo-legsw').onclick = () => row.querySelector('.lo-legedit').classList.toggle('hidden');
      row.querySelector('.lo-legdel').onclick = () => {
        const n = LC.usage(lay, e.id);
        if (n) return toast(`${n} drawing${n > 1 ? 's use' : ' uses'} “${e.label}” — change or delete ${n > 1 ? 'them' : 'it'} first`);
        pushUndo(); lay.legend = lay.legend.filter((x) => x !== e); changed();
      };
      bindStyle('leg-' + e.id, (w) => {
        pushUndo(); Object.assign(e, w); delete e.auto; changed();
        const r = [...document.querySelectorAll('.lo-leg')].find((x) => x.dataset.id === e.id); if (r) r.querySelector('.lo-legedit').classList.remove('hidden');
      });
    });
    $('loLegAdd').onclick = () => { pushUndo(); const sym = $('loLegSym').value; lay.legend.push({ id: LC.newId('lg'), label: 'New entry', color: '#ffffff', dash: 'solid', width: 3, sym }); changed(); };
    $('loLegReset').onclick = () => { pushUndo(); for (const d of LC.DEFAULT_LEGEND) if (!LC.entryOf(lay, d.id)) lay.legend.push(JSON.parse(JSON.stringify(d))); changed(); };
  }
  function renderPlanTab(body) {
    const o = lay.opts, m = lay.meta;
    const seg = (id, key, opts) => `<div class="seg lo-seg" id="${id}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${o[key] === v ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    const canShare = !!(navigator.canShare && window.File);
    body.innerHTML = `<label>Owner / job name<input type="text" id="loName" value="${esc(lay.name)}" maxlength="120"></label>
      <label>APN<input type="text" id="loApn" inputmode="numeric" value="${esc(lay.apn)}" placeholder="285-030-06-00"></label>
      <div class="sb-row"><button type="button" class="small" id="loParcel">▦ Load parcel lines from APN</button></div><div id="loParcelMsg" class="small-note"></div>
      <label>Address<input type="text" id="loAddr" value="${esc(lay.address)}" maxlength="200"></label>
      <label>Prepared by<input type="text" id="loBy" value="${esc(m.preparedBy)}" maxlength="120"></label>
      <label>Date<input type="text" id="loDate" value="${esc(m.date)}" maxlength="40"></label>
      <label>Notes<textarea id="loNotes" rows="3" maxlength="2000" placeholder="e.g. 1,500 gal tank, 2 × 60 ft leach lines, 100% reserve">${esc(m.notes)}</textarea></label>
      <div class="lo-sub">Page (letter size)</div>${seg('loOrient', 'orientation', [['landscape', '▭ Landscape'], ['portrait', '▯ Portrait']])}
      <div class="lo-sub">Map area</div>${seg('loArea', 'area', [['fit', 'Fit the drawing'], ['view', 'Current map view']])}
      <div class="lo-toggles"><label><input type="checkbox" id="loPRings" ${o.rings ? 'checked' : ''}> Setback rings</label><label><input type="checkbox" id="loPSizes" ${o.sizes !== false ? 'checked' : ''}> Lengths &amp; areas</label><label><input type="checkbox" id="loPWarn" ${o.warnings !== false ? 'checked' : ''}> Setback warnings</label></div>
      <div class="sb-row lo-exp"><button type="button" class="small good" id="loPng">⬇ PNG</button><button type="button" class="small good" id="loPdf">⬇ PDF</button>${canShare ? '<button type="button" class="small" id="loShare">📤 Share PDF</button>' : ''}</div>
      <div id="loExpMsg" class="small-note"></div>
      <div class="sb-row"><button type="button" class="small" id="loJson">⬇ Backup (.json)</button><button type="button" class="small danger" id="loDelLay">🗑 Delete layout</button></div>
      <p class="small-note muted">🔒 This layout is stored only on this device and never uploaded. PNG / PDF / backup files are made on the phone; only the APN goes to the County parcel service when you load parcel lines.</p>`;
    const txt = (id, fn) => ($(id).oninput = (e) => { fn(e.target.value); lay.updated = new Date().toISOString(); scheduleSave(); $('loTitle').textContent = '✏️ ' + (lay.name || 'Septic layout'); });
    txt('loName', (v) => (lay.name = v)); txt('loApn', (v) => (lay.apn = v)); txt('loAddr', (v) => (lay.address = v));
    txt('loBy', (v) => (m.preparedBy = v)); txt('loDate', (v) => (m.date = v)); txt('loNotes', (v) => (m.notes = v));
    const segBind = (id, key) => $(id).querySelectorAll('button').forEach((b) => (b.onclick = () => { o[key] = b.dataset.v; scheduleSave(); $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); }));
    segBind('loOrient', 'orientation'); segBind('loArea', 'area');
    $('loPRings').onchange = (e) => { o.rings = e.target.checked; scheduleSave(); render(); };
    $('loPSizes').onchange = (e) => { o.sizes = e.target.checked; scheduleSave(); render(); };
    $('loPWarn').onchange = (e) => { o.warnings = e.target.checked; scheduleSave(); render(); };
    $('loParcel').onclick = () => loadParcel($('loApn').value);
    $('loPng').onclick = () => exportPlan('png');
    $('loPdf').onclick = () => exportPlan('pdf');
    if ($('loShare')) $('loShare').onclick = () => exportPlan('pdf', true);
    $('loJson').onclick = () => downloadJson(lay);
    $('loDelLay').onclick = async () => {
      if (!confirm(`Delete the layout “${lay.name}” from this device?\nThis cannot be undone (save a backup first if unsure).`)) return;
      const id = lay.id; clearTimeout(saveT); lay = null;
      try { await Store.del(id); } catch (e) { /* */ }
      toast('Layout deleted'); openList();
    };
  }

  // ------------------------------------------------------------------ parcel lines from APN (reuses the 🔍 search's County parcel query)
  async function fetchParcel(raw) {
    const S = window.WellsSearch;
    if (!S || !S.lookup) throw new Error('search module missing');
    const p = S.parseApn(raw);
    if (!p || p.bad) throw new Error('Type the APN as XXX-XXX-XX-XX (dashes optional)');
    const res = await S.lookup(raw);
    if (res.msg) throw new Error(res.msg.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' '));
    const d = String(raw).replace(/\D/g, '');
    const c = res.cands.find((x) => String(x.apn).replace(/\D/g, '') === d) || res.cands[0];
    if (!c || !c.rings || !c.rings.length) throw new Error('No parcel outline found');
    return c;
  }
  async function loadParcel(raw) {
    const say = (h, cls) => { const msg = $('loParcelMsg'); if (msg) { msg.innerHTML = h; msg.className = 'small-note ' + (cls || ''); } };
    if (!String(raw || '').trim()) { say('Type the APN first (e.g. 285-030-06-00).', 'warnc'); return false; }
    say('Looking up the parcel…', 'muted');
    const target = lay;
    let c;
    try { c = await fetchParcel(raw); } catch (e) { say(`${navigator.onLine === false ? '📵 No signal — ' : ''}${esc(e.message || e)}`, 'bad'); return false; }
    if (!lay || lay !== target) return false;
    const shapes = LC.parcelShapes(c.rings, c.apn);
    const old = lay.shapes.filter((s) => s.src === 'parcel');
    if (old.length && !confirm(`Replace the ${old.length} property line${old.length > 1 ? 's' : ''} loaded before with parcel ${c.apn}?`)) { say('Kept the existing property lines.', 'muted'); return false; }
    pushUndo();
    lay.shapes = lay.shapes.filter((s) => s.src !== 'parcel').concat(shapes);
    LC.ensureKindEntry(lay, 'prop');
    if (!lay.apn || String(lay.apn).replace(/\D/g, '') === String(c.apn).replace(/\D/g, '')) lay.apn = c.apn;
    if (!lay.address && c.address) lay.address = c.address;
    map.fitBounds(L.latLngBounds(shapes.flatMap((s) => s.pts)).pad(0.15), { maxZoom: 20, animate: false });
    changed();
    const nPts = shapes.reduce((a, s) => a + s.pts.length, 0);
    toast(`Parcel lines added: APN ${c.apn} — tap them to adjust`);
    say(`✓ APN ${esc(c.apn)}${c.address ? ' · ' + esc(c.address) : ''}: ${shapes.length} outline${shapes.length > 1 ? 's' : ''}, ${nPts} corners (County GIS — approximate, not a survey).`, 'okc');
    return true;
  }

  // ------------------------------------------------------------------ plot plan (canvas -> PNG / PDF)
  function loadImg(url) {
    return new Promise((res) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      const t = setTimeout(() => { res(null); }, 20000);
      im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); };
      im.src = url;
    });
  }
  /** Esri tile templates to print: the base map shown now (satellite or streets) + roads / labels if they are on. */
  function tileTemplates() {
    const urls = [];
    map.eachLayer((l) => { if (l instanceof L.TileLayer && /arcgisonline\.com/.test(l._url || '') && !urls.includes(l._url)) urls.push(l._url); });
    const isBase = (u) => /World_Imagery|World_Street_Map/.test(u);
    const base = urls.filter(isBase), ref = urls.filter((u) => !isBase(u));
    return (base.length ? base.slice(0, 1) : ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}']).concat(ref);
  }
  function wrap(ctx, text, maxW) {
    const out = [];
    for (const para of String(text || '').split(/\n/)) {
      let line = '';
      for (const w of para.split(/\s+/)) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
      out.push(line);
    }
    return out;
  }
  function pill(ctx, x, y, text, k, o = {}) {
    const lines = String(text).split('\n');
    ctx.font = `700 ${Math.round(11.5 * k)}px sans-serif`;
    const lh = 14 * k, w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 10 * k, h = lines.length * lh + 4 * k;
    const x0 = o.left ? x : o.right ? x - w : x - w / 2, y0 = y - h / 2;
    ctx.fillStyle = o.bg || 'rgba(15,23,42,.82)';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y0, w, h, 6 * k); else ctx.rect(x0, y0, w, h); ctx.fill();
    if (o.border) { ctx.strokeStyle = o.border; ctx.lineWidth = 2 * k; ctx.stroke(); }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((t, i) => ctx.fillText(t, x0 + w / 2, y0 + 2 * k + lh * (i + 0.5)));
  }
  function strokePath(ctx, pts, close) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (close) ctx.closePath(); }
  function drawPlanShapes(ctx, l, P, k) {
    const chk = LC.setbackChecks(l), bad = new Set(l.opts.warnings !== false ? chk.inside.map((r) => r.shape.id) : []);
    ctx.lineJoin = 'round';
    if (l.opts.rings) for (const w of chk.wells) for (const r of K.RINGS) {
      strokePath(ctx, K.circle(w, r.ft, 120).map(P), true);
      ctx.setLineDash(r.ft === 150 ? [] : [7 * k, 5 * k]); ctx.strokeStyle = r.color; ctx.lineWidth = 2.5 * k; ctx.stroke(); ctx.setLineDash([]);
    }
    for (const s of sorted(l)) {
      const g = geomOf(s); if (!s.pts || !s.pts.length) continue;
      const xy = s.pts.map(P);
      if (g === 'line' || g === 'poly') {
        const st = LC.styleOf(l, s), closed = g === 'poly' || s.closed;
        if (bad.has(s.id)) { strokePath(ctx, xy, closed); ctx.strokeStyle = 'rgba(220,38,38,.5)'; ctx.lineWidth = (st.width + 12) * k; ctx.lineCap = 'round'; ctx.stroke(); }
        strokePath(ctx, xy, closed);
        if (g === 'poly' && xy.length > 2) { ctx.globalAlpha = 0.18; ctx.fillStyle = st.color; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.strokeStyle = lum(st.color) > 0.55 ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.45)'; ctx.lineWidth = (st.width + 2) * k; ctx.lineCap = 'round'; ctx.stroke();
        const d = dashFor(st, k); ctx.setLineDash(d || []); ctx.lineCap = d ? 'butt' : 'round';
        ctx.strokeStyle = st.color; ctx.lineWidth = st.width * k; ctx.stroke(); ctx.setLineDash([]);
      } else if (g === 'dim' && xy.length > 1) {
        strokePath(ctx, xy); ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = 4 * k; ctx.lineCap = 'butt'; ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * k; ctx.stroke();
        const [a, b] = xy, ang = Math.atan2(b.y - a.y, b.x - a.x), nx = -Math.sin(ang) * 7 * k, ny = Math.cos(ang) * 7 * k;
        for (const q of [a, b]) { ctx.beginPath(); ctx.moveTo(q.x - nx, q.y - ny); ctx.lineTo(q.x + nx, q.y + ny); ctx.strokeStyle = '#000'; ctx.lineWidth = 4 * k; ctx.stroke(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * k; ctx.stroke(); }
      } else if (g === 'point') {
        const st = LC.styleOf(l, s), q = xy[0], r = 12 * k;
        if (bad.has(s.id)) { ctx.beginPath(); ctx.arc(q.x, q.y, r + 7 * k, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(220,38,38,.55)'; ctx.fill(); }
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 2 * Math.PI); ctx.fillStyle = st.color; ctx.fill();
        ctx.lineWidth = 2.5 * k; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.beginPath(); ctx.arc(q.x, q.y, r + 1.8 * k, 0, 2 * Math.PI); ctx.lineWidth = 1.2 * k; ctx.strokeStyle = '#000'; ctx.stroke();
        ctx.fillStyle = ink(st.color); ctx.font = `800 ${Math.round(10 * k)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(KINDS[s.kind].code, q.x, q.y + 0.5 * k);
      } else if (g === 'text') {
        const c = s.color || '#ffffff', q = xy[0];
        ctx.font = `800 ${Math.round(TEXT_PX[s.size || 'm'] * k)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 4 * k; ctx.strokeStyle = lum(c) > 0.55 ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.9)'; ctx.lineJoin = 'round';
        ctx.strokeText(s.text || '', q.x, q.y); ctx.fillStyle = c; ctx.fillText(s.text || '', q.x, q.y);
      }
    }
    if (l.opts.warnings !== false) for (const r of chk.inside) {
      strokePath(ctx, [P(r.wellPt), P(r.nearest)]); ctx.setLineDash([4 * k, 5 * k]); ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2.5 * k; ctx.stroke(); ctx.setLineDash([]);
    }
    for (const b of labelsFor(l, chk)) {
      if (!b.ll) continue;
      const q = P(b.ll);
      if (b.cls === 'pt') pill(ctx, q.x + 16 * k, q.y, b.text, k, { left: true });
      else if (b.cls === 'bad') pill(ctx, q.x + (b.right ? 18 : -18) * k, q.y, b.text, k, { bg: '#dc2626', left: b.right, right: !b.right });
      else if (b.cls === 'ring') pill(ctx, q.x, q.y, b.text, k, { border: b.color });
      else if (b.cls === 'seg') pill(ctx, q.x, q.y, b.text, k, { bg: 'rgba(15,23,42,.7)' });
      else pill(ctx, q.x, q.y, b.text, k);
    }
  }
  function northArrow(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y);
    ctx.beginPath(); ctx.arc(0, 0, s, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill(); ctx.lineWidth = s * 0.04; ctx.strokeStyle = '#000'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -s * 0.55); ctx.lineTo(s * 0.3, s * 0.6); ctx.lineTo(0, s * 0.38); ctx.closePath(); ctx.fillStyle = '#000'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -s * 0.55); ctx.lineTo(-s * 0.3, s * 0.6); ctx.lineTo(0, s * 0.38); ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = s * 0.035; ctx.stroke();
    ctx.fillStyle = '#000'; ctx.font = `800 ${Math.round(s * 0.36)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', 0, -s * 0.74);
    ctx.restore();
  }
  /** Draw the whole letter-size plot plan. Returns {canvas, info}. */
  async function renderPlan(l, o = {}) {
    const portrait = (o.orientation || l.opts.orientation) === 'portrait';
    const DPI = o.dpi || 200, W = Math.round((portrait ? 8.5 : 11) * DPI), H = Math.round((portrait ? 11 : 8.5) * DPI);
    const k = DPI / 96, m = Math.round(0.35 * DPI), gap = Math.round(0.15 * DPI);
    const panel = portrait ? { x: m, y: 0, w: W - 2 * m, h: Math.round(3.0 * DPI) } : { x: 0, y: m, w: Math.round(3.0 * DPI), h: H - 2 * m };
    const fr = portrait ? { x: m, y: m, w: W - 2 * m, h: H - 2 * m - panel.h - gap } : { x: m, y: m, w: W - 2 * m - panel.w - gap, h: H - 2 * m };
    if (portrait) panel.y = fr.y + fr.h + gap; else panel.x = fr.x + fr.w + gap;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    // ---- map area: what to show and at what (fractional) zoom
    const crs = L.CRS.EPSG3857;
    const b = (o.area || l.opts.area) === 'view' ? null : LC.boundsOf(l, l.opts.rings);
    let bnds = b ? L.latLngBounds(b) : map.getBounds();
    if (b) {   // pad 10 %, and never closer than ~120 ft across
      const c = bnds.getCenter(), ne = crs.latLngToPoint(bnds.getNorthEast(), 0), sw = crs.latLngToPoint(bnds.getSouthWest(), 0);
      const padX = (ne.x - sw.x) * 0.1, padY = (sw.y - ne.y) * 0.1;
      bnds = L.latLngBounds(crs.pointToLatLng(L.point(sw.x - padX, sw.y + padY), 0), crs.pointToLatLng(L.point(ne.x + padX, ne.y - padY), 0));
      bnds.extend(c.toBounds(120 * M_PER_FT));
    }
    const p1 = crs.latLngToPoint(bnds.getNorthWest(), 0), p2 = crs.latLngToPoint(bnds.getSouthEast(), 0);
    const z = Math.min(22, Math.log2(Math.min(fr.w / Math.max(1e-9, p2.x - p1.x), fr.h / Math.max(1e-9, p2.y - p1.y))));
    const center = crs.latLngToPoint(bnds.getCenter(), z);
    const origin = L.point(center.x - fr.w / 2, center.y - fr.h / 2);
    const P = (p) => { const q = crs.latLngToPoint(L.latLng(p[0], p[1]), z); return { x: q.x - origin.x + fr.x, y: q.y - origin.y + fr.y }; };
    // ---- imagery tiles (Esri sends Access-Control-Allow-Origin: *, so the canvas stays exportable)
    let tz = Math.max(1, Math.min(19, Math.ceil(z - 0.15)));
    const range = (t) => { const s = Math.pow(2, z - t), ts = 256 * s; return { ts, x0: Math.floor(origin.x / ts), y0: Math.floor(origin.y / ts), x1: Math.floor((origin.x + fr.w) / ts), y1: Math.floor((origin.y + fr.h) / ts) }; };
    let R = range(tz);
    while ((R.x1 - R.x0 + 1) * (R.y1 - R.y0 + 1) > 110 && tz > 1) R = range(--tz);
    const temps = tileTemplates(), info = { zoom: +z.toFixed(2), tileZoom: tz, tiles: 0, tilesOk: 0, layers: temps.length };
    ctx.save(); ctx.beginPath(); ctx.rect(fr.x, fr.y, fr.w, fr.h); ctx.clip();
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
    const n = Math.pow(2, tz);
    for (const tpl of temps) {
      const jobs = [];
      for (let ty = R.y0; ty <= R.y1; ty++) for (let tx = R.x0; tx <= R.x1; tx++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        info.tiles++;
        jobs.push(loadImg(tpl.replace('{z}', tz).replace('{y}', ty).replace('{x}', wx)).then((im) => ({ im, tx, ty })));
      }
      for (const { im, tx, ty } of await Promise.all(jobs)) {
        if (!im) continue;
        info.tilesOk++;
        ctx.drawImage(im, fr.x + tx * R.ts - origin.x, fr.y + ty * R.ts - origin.y, R.ts + 0.5, R.ts + 0.5);
      }
    }
    drawPlanShapes(ctx, l, P, k);
    ctx.restore();
    ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);
    // ---- north arrow + scale bar on the map
    northArrow(ctx, fr.x + fr.w - 0.45 * DPI, fr.y + 0.5 * DPI, 0.3 * DPI);
    const lat = bnds.getCenter().lat, ftPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, z)) * LC.FT_PER_M;
    const sc = LC.niceScale(ftPerPx, 1.6 * DPI);
    info.ftPerInch = +(ftPerPx * DPI).toFixed(1); info.scaleFt = sc.ft; info.scalePx = sc.px;
    {
      const bx = fr.x + 0.25 * DPI, by = fr.y + fr.h - 0.5 * DPI, bw = sc.px, bh = 0.07 * DPI;
      const boxX = bx - 0.15 * DPI, boxY = by - 0.22 * DPI, boxW = Math.max(bw + 0.6 * DPI, 2.3 * DPI), boxH = 0.6 * DPI;
      ctx.fillStyle = 'rgba(255,255,255,.93)'; ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(boxX, boxY, boxW, boxH);
      for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#fff' : '#000'; ctx.fillRect(bx + (bw / 4) * i, by, bw / 4, bh); }
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = '#000'; ctx.font = `700 ${Math.round(0.085 * DPI)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      [0, 0.5, 1].forEach((f) => ctx.fillText(f === 1 ? `${sc.ft} ft` : String(Math.round(sc.ft * f)), bx + bw * f, by - 0.02 * DPI));
      ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.font = `600 ${Math.round(0.075 * DPI)}px sans-serif`;
      ctx.fillText(`1 inch ≈ ${Math.round(ftPerPx * DPI)} ft (printed at 100%)`, bx, by + bh + 0.06 * DPI);
    }
    drawPanel(ctx, l, panel, DPI, k, portrait, info);
    return { canvas: cv, info: { ...info, width: W, height: H, portrait } };
  }
  function drawSwatch(ctx, e, x, y, w, h, k) {
    const cy = y + h / 2;
    if (e.sym === 'point') { ctx.beginPath(); ctx.arc(x + w / 2, cy, h * 0.42, 0, 2 * Math.PI); ctx.fillStyle = e.color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke(); return; }
    const lw = Math.min(8, e.width) * k * 0.8, d = e.dash === 'dashed' ? [e.width * 1.8 * k, e.width * 1.4 * k] : [];
    if (e.sym === 'area') {
      ctx.globalAlpha = 0.3; ctx.fillStyle = e.color; ctx.fillRect(x, y + h * 0.1, w, h * 0.8); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#475569'; ctx.lineWidth = lw + 3; ctx.strokeRect(x, y + h * 0.1, w, h * 0.8);
      ctx.setLineDash(d); ctx.strokeStyle = e.color; ctx.lineWidth = lw; ctx.strokeRect(x, y + h * 0.1, w, h * 0.8); ctx.setLineDash([]); return;
    }
    ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy);
    ctx.strokeStyle = '#475569'; ctx.lineWidth = lw + 3; ctx.lineCap = 'butt'; ctx.stroke();
    ctx.setLineDash(d); ctx.strokeStyle = e.color; ctx.lineWidth = lw; ctx.stroke(); ctx.setLineDash([]);
  }
  function drawPanel(ctx, l, pn, DPI, k, portrait, info) {
    const pad = 0.1 * DPI, fs = (pt) => Math.round(pt * DPI / 72);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeRect(pn.x, pn.y, pn.w, pn.h);
    const cols = portrait ? [{ x: pn.x, w: pn.w * 0.5 }, { x: pn.x + pn.w * 0.5, w: pn.w * 0.5 }] : [{ x: pn.x, w: pn.w }];
    if (portrait) { ctx.beginPath(); ctx.moveTo(pn.x + pn.w * 0.5, pn.y); ctx.lineTo(pn.x + pn.w * 0.5, pn.y + pn.h); ctx.lineWidth = 2; ctx.stroke(); }
    let col = 0, y = pn.y + pad;
    const footH = fs(6.5) * 4;
    const bottom = () => pn.y + pn.h - pad - (col === cols.length - 1 ? footH : 0);
    const X = () => cols[col].x + pad, Wd = () => cols[col].w - 2 * pad;
    const nextCol = () => { if (col + 1 < cols.length) { col++; y = pn.y + pad; return true; } return false; };
    const text = (t, size, weight = 400, color = '#000') => {
      ctx.font = `${weight} ${fs(size)}px sans-serif`;
      for (const line of wrap(ctx, t, Wd())) {
        if (y + fs(size) * 1.25 > bottom() && !nextCol()) return false;
        ctx.font = `${weight} ${fs(size)}px sans-serif`; ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(line, X(), y); y += fs(size) * 1.25;
      }
      return true;
    };
    const rule = () => { y += 0.03 * DPI; ctx.beginPath(); ctx.moveTo(cols[col].x, y); ctx.lineTo(cols[col].x + cols[col].w, y); ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke(); y += 0.06 * DPI; };
    const field = (key, v) => {
      if (y + fs(8) * 2.6 > bottom()) nextCol();
      ctx.font = `700 ${fs(7.5)}px sans-serif`; ctx.fillStyle = '#475569'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(key.toUpperCase(), X(), y); y += fs(7.5) * 1.15;
      text(v || '—', 10, 600);
      y += 0.015 * DPI;
    };
    text('PLOT PLAN', 17, 800);
    text('Onsite wastewater (septic) system & water well', 9, 600, '#334155');
    rule();
    field('Owner / job', l.name);
    field('APN', l.apn);
    field('Address', l.address);
    field('Prepared by', l.meta.preparedBy);
    field('Date', l.meta.date);
    field('Scale', `1 in ≈ ${Math.round(info.ftPerInch)} ft at letter size — use the bar scale`);
    if (l.meta.notes) field('Notes', l.meta.notes);
    if (portrait) nextCol(); else rule();
    text('LEGEND', 10.5, 800);
    const chk = LC.setbackChecks(l);
    const rows = LC.usedLegend(l).map((e) => [e, e.label]);
    if (l.opts.rings && chk.wells.length) for (const r of K.RINGS) rows.push([RING_ENTRY(r), `${r.ft} ft well setback (${r.label.split('·')[1].trim()})`]);
    if (!rows.length) text('(nothing drawn)', 9, 400, '#64748b');
    for (const [e, lab] of rows) {
      ctx.font = `600 ${fs(9)}px sans-serif`;
      const lines = wrap(ctx, lab, Wd() - 0.5 * DPI), rh = Math.max(fs(10) * 1.4, lines.length * fs(9) * 1.2 + fs(9) * 0.4);
      if (y + rh > bottom() && !nextCol()) break;
      drawSwatch(ctx, e, X(), y + (rh - fs(10) * 1.2) / 2, 0.4 * DPI, fs(10) * 1.2, k);
      ctx.font = `600 ${fs(9)}px sans-serif`; ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      lines.forEach((t, i) => ctx.fillText(t, X() + 0.5 * DPI, y + rh / 2 + (i - (lines.length - 1) / 2) * fs(9) * 1.2));
      y += rh;
    }
    rule();
    text('WELL SETBACKS', 10.5, 800);
    text('Sewer / tight line 50 ft · septic tank, distribution box, leach line / field, reserve area 100 ft · seepage pit 150 ft', 8, 500, '#334155');
    if (!chk.rows.length) text(chk.wells.length ? 'No septic items drawn.' : 'No well drawn.', 8.5, 500, '#64748b');
    else if (!chk.wells.length) text('No well drawn — setbacks not checked.', 8.5, 700, '#b45309');
    else {
      const shown = chk.rows.slice().sort((a, b2) => (a.status === 'inside' ? 0 : 1) - (b2.status === 'inside' ? 0 : 1)).slice(0, portrait ? 6 : 9);
      for (const r of shown) if (!text(LC.checkText(r), 8, r.status === 'inside' ? 800 : 500, r.status === 'inside' ? '#b91c1c' : r.status === 'near' ? '#92400e' : '#166534')) break;
      if (chk.rows.length > shown.length) text(`+ ${chk.rows.length - shown.length} more`, 8, 500, '#334155');
    }
    const last = cols[cols.length - 1];
    ctx.font = `400 ${fs(6.5)}px sans-serif`; ctx.fillStyle = '#475569'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const foot = wrap(ctx, `Imagery © Esri, Maxar, Earthstar Geographics.${l.shapes.some((s) => s.src === 'parcel') ? ' Property lines: County of San Diego / SanGIS parcels (approximate, not a survey).' : ''} Distances measured on aerial imagery — verify in the field.`, last.w - 2 * pad);
    foot.reverse().forEach((t, i) => ctx.fillText(t, last.x + pad, pn.y + pn.h - pad * 0.6 - i * fs(6.5) * 1.2));
  }
  const toBlob = (cv, type, q) => new Promise((res, rej) => { try { cv.toBlob((b2) => (b2 ? res(b2) : rej(new Error('could not make the image'))), type, q); } catch (e) { rej(e); } });
  const slug = (s) => String(s || '').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'layout';
  function saveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  async function makePlan(fmt, l = lay) {
    const { canvas, info } = await renderPlan(l);
    let blob;
    if (fmt === 'png') blob = await toBlob(canvas, 'image/png');
    else {
      const jpg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer());
      const pdf = LC.pdfFromJpeg(jpg, canvas.width, canvas.height, info.portrait ? 612 : 792, info.portrait ? 792 : 612, `Plot plan ${l.name} ${l.apn}`);
      blob = new Blob([pdf], { type: 'application/pdf' });
    }
    const name = `plot-plan_${slug(l.name)}${l.apn ? '_' + slug(l.apn) : ''}_${slug(l.meta.date || LC.localDate())}.${fmt}`;
    lastExport = { fmt, name, size: blob.size, ...info };
    return { blob, name, info };
  }
  let exporting = false;
  async function exportPlan(fmt, share) {
    if (!lay || exporting) return;
    const say = (h, cls) => { const msg = $('loExpMsg'); if (msg) { msg.innerHTML = h; msg.className = 'small-note ' + (cls || ''); } };
    exporting = true; say('⏳ Drawing the plot plan (loading imagery)…', 'muted');
    try {
      await saveNow();
      const { blob, name, info } = await makePlan(fmt);
      const note = info.tilesOk < info.tiles ? ` — ${info.tiles - info.tilesOk} of ${info.tiles} imagery tiles did not load${navigator.onLine === false ? ' (no signal)' : ''}` : '';
      if (share && navigator.canShare) {
        const file = new File([blob], name, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: `Plot plan — ${lay ? lay.name : ''}` }); say(`✓ Shared ${esc(name)}${note}`, note ? 'warnc' : 'okc'); return; }
          catch (e) { if (e && e.name === 'AbortError') { say('Share cancelled.', 'muted'); return; } }
        }
      }
      saveBlob(blob, name);
      say(`✓ ${esc(name)} (${Math.round(blob.size / 1024)} KB, letter ${info.portrait ? 'portrait' : 'landscape'}, 1 in ≈ ${Math.round(info.ftPerInch)} ft)${note}`, note ? 'warnc' : 'okc');
    } catch (e) {
      console.error('plot plan failed', e);
      say(`Could not make the plot plan: ${esc(e.message || e)}`, 'bad');
    } finally { exporting = false; }
  }
  function downloadJson(l) { saveBlob(new Blob([LC.exportJson(l)], { type: 'application/json' }), `septic-layout_${slug(l.name)}${l.apn ? '_' + slug(l.apn) : ''}.json`); }

  // ------------------------------------------------------------------ layouts list + new layout
  const when = (iso) => { try { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso || ''; } };
  async function openList() {
    let list = [];
    try { list = await Store.all(); } catch (e) { toast('Device storage unavailable (private mode?)'); }
    WS().openSheet('layouts', `<div class="sheet-head"><b>✏️ Septic layouts (${list.length})</b><button type="button" class="small" id="llClose">Close</button></div>
      <button type="button" class="big good" id="llNew">＋ New layout here</button>
      <div class="l-tools" style="margin-top:8px"><label class="small btnlike">⬆ Import backup (.json)<input id="llImport" type="file" accept=".json,application/json" hidden></label></div>
      <p class="muted small-note">Draw the septic system on the satellite map and export a plot plan (PNG / PDF). 🔒 Layouts are stored only on this device, never uploaded — use ⬇ Backup to move one to another phone.</p>
      <div class="l-items" id="llItems">${list.length ? '' : '<p class="muted">No layouts yet.</p>'}</div>`);
    const box = $('llItems');
    for (const l of list) {
      const chk = LC.setbackChecks(l);
      const it = document.createElement('div'); it.className = 'l-item';
      it.innerHTML = `<div class="l-main"><b>${esc(l.name)}</b> <small class="muted">${esc(when(l.updated))}</small><br>
        ${l.apn ? `APN <b>${esc(l.apn)}</b>` : '<span class="muted">no APN</span>'}${l.address ? ` · <small>${esc(l.address)}</small>` : ''}<br>
        <small class="muted">${l.shapes.length} item${l.shapes.length === 1 ? '' : 's'}${chk.inside.length ? ` · <b class="bad">⚠ ${chk.inside.length} setback problem${chk.inside.length > 1 ? 's' : ''}</b>` : chk.rows.length && chk.wells.length ? ' · ✓ setbacks OK' : ''}</small></div>
        <div class="site-actions"><button type="button" class="small good ll-open">✏️ Open</button><button type="button" class="small ll-ren">Rename</button><button type="button" class="small ll-json">⬇ Backup</button><button type="button" class="small danger ll-del" aria-label="Delete">🗑</button></div>`;
      it.querySelector('.l-main').onclick = () => openEditor(l);
      it.querySelector('.ll-open').onclick = () => openEditor(l);
      it.querySelector('.ll-ren').onclick = async () => { const n = prompt('Layout name (owner / job):', l.name); if (n == null || !n.trim()) return; l.name = n.trim(); l.updated = new Date().toISOString(); await Store.put(l); openList(); };
      it.querySelector('.ll-json').onclick = () => downloadJson(l);
      it.querySelector('.ll-del').onclick = async () => { if (!confirm(`Delete the layout “${l.name}” from this device?\nThis cannot be undone.`)) return; await Store.del(l.id); toast('Layout deleted'); openList(); };
      box.appendChild(it);
    }
    $('llClose').onclick = () => WS().closeSheet();
    $('llNew').onclick = () => openNew();
    $('llImport').onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      try {
        const got = LC.parseFile(await f.text());
        const have = new Set(list.map((x) => x.id));
        for (const l of got) { if (have.has(l.id)) { l.id = LC.newId('lay'); l.name += ' (imported)'; } await Store.put(l); }
        toast(`Imported ${got.length} layout${got.length > 1 ? 's' : ''}`);
        openList();
      } catch (err) { alert('Import failed: ' + (err.message || err)); }
    };
  }
  function openNew(pre = {}) {
    WS().openSheet('layout-new', `<div class="sheet-head"><b>✏️ New septic layout</b><button type="button" class="small" id="lnCancel">Cancel</button></div>
      <label>Owner / job name *<input type="text" id="lnName" autocapitalize="words" maxlength="120" value="${esc(pre.name || '')}"></label>
      <label>APN <small id="lnApnSrc"></small><input type="text" id="lnApn" inputmode="numeric" placeholder="285-030-06-00" value="${esc(pre.apn || '')}"></label>
      <label>Address<input type="text" id="lnAddr" maxlength="200" value="${esc(pre.address || '')}"></label>
      <label class="lo-chk"><input type="checkbox" id="lnParcel" checked> Load the parcel's property lines from the County (by APN)</label>
      <div class="f-err" id="lnErr"></div>
      <button type="button" class="big good" id="lnGo">Start drawing</button>
      <p class="muted small-note">Starts on the map where you are looking now (search an address or APN with 🔍 first to go there). 🔒 Stored only on this device.</p>`);
    $('lnCancel').onclick = () => openList();
    let touched = false;
    ['lnApn', 'lnAddr'].forEach((id) => ($(id).oninput = () => { touched = true; }));
    if (!pre.apn) prefillParcel().then((p) => {
      if (!p || touched || !$('lnApn') || $('lnApn').value) return;
      $('lnApn').value = p.apn || ''; if (!$('lnAddr').value) $('lnAddr').value = p.address || ''; $('lnApnSrc').textContent = p.src || '';
    });
    $('lnGo').onclick = async () => {
      const name = $('lnName').value.trim();
      if (!name) { $('lnErr').textContent = 'Type the owner / job name.'; $('lnName').focus(); return; }
      const c = map.getCenter();
      const l = LC.newLayout({ name, apn: $('lnApn').value.trim(), address: $('lnAddr').value.trim(), siteId: pre.siteId || null,
        view: { lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), z: Math.max(map.getZoom(), 18) } });
      try { await Store.put(l); } catch (e) { $('lnErr').textContent = 'Could not save on this device: ' + (e.message || e); return; }
      const wantParcel = $('lnParcel').checked && l.apn;
      openEditor(l, wantParcel ? { tab: 'plan' } : {});
      if (wantParcel) { const ok = await loadParcel(l.apn); if (ok && lay === l && !tool && !sel) { tab = 'draw'; renderSheet(); } }
    };
  }
  /** APN + address for a new layout: the 🔍 search pin if it is on screen, else the parcel under the map centre. */
  async function prefillParcel() {
    const S = window.WellsSearch, last = S && S.last;
    if (last && last.apn && map.getBounds().contains([last.lat, last.lon])) return { apn: last.apn, address: last.address || '', src: '(from your search)' };
    if (!WS() || !WS().lookupParcel) return null;
    try { const c = map.getCenter(), p = await WS().lookupParcel(c.lat, c.lng); return p && p.found ? { apn: p.apn, address: p.address, src: '(parcel at the map centre)' } : null; } catch (e) { return null; }
  }
  /** From a tagged well site: its layout, or a new one with the proposed well, its parcel lines and its septic marks. */
  async function openForSite(s) {
    map.closePopup();
    let list = [];
    try { list = await Store.all(); } catch (e) { /* */ }
    const have = list.find((l) => l.siteId === s.id);
    if (have) return openEditor(have);
    const l = LC.newLayout({ name: s.customer || 'Well site', apn: s.apn || '', address: s.address || '', siteId: s.id, view: { lat: s.lat, lon: s.lon, z: 19 } });
    l.shapes.push({ id: LC.newId('sh'), kind: 'pwell', pts: [[+s.lat.toFixed(7), +s.lon.toFixed(7)]], legendId: 'pwell' });
    if (s.parcel && s.parcel.rings) l.shapes.push(...LC.parcelShapes(s.parcel.rings, s.parcel.apn));
    const MAP = { tank: 'tank', pit: 'pit', leach: 'leach', sewer: 'sewer', tight: 'tight' };
    for (const mk of s.marks || []) if (MAP[mk.kind] && mk.pts && mk.pts.length) l.shapes.push({ id: LC.newId('sh'), kind: MAP[mk.kind], pts: mk.pts.map((p) => [+p[0], +p[1]]), legendId: KINDS[MAP[mk.kind]].legend });
    try { await Store.put(l); } catch (e) { toast('Could not save on this device'); }
    openEditor(l, { fit: true });
    toast('New layout for this site: proposed well' + (s.parcel && s.parcel.rings ? ' + parcel lines' : '') + ' added');
  }
  /** A 🔍 search result while drawing: zoom to the parcel; fill in the APN / address if the layout has none. */
  function onSearch(c) {
    if (!active || !lay) return;
    if (c.rings && c.rings.length) map.fitBounds(L.latLngBounds(c.rings.flat()).pad(0.15), { maxZoom: 20, animate: false });
    else map.setView([c.lat, c.lon], Math.max(18, map.getZoom()), { animate: false });
    if (c.apn && !lay.apn) { lay.apn = c.apn; if (!lay.address && c.address) lay.address = c.address; scheduleSave(); renderSheet(); toast(`APN ${c.apn} set for this layout`); }
  }
  function onSheetClose() { leaveMode(); }

  // ------------------------------------------------------------------ entry point: bottom bar button
  const btn = $('btnLayout');
  if (btn) btn.onclick = async () => { let n = 0; try { n = (await Store.all()).length; } catch (e) { /* */ } if (n) openList(); else openNew(); };

  window.WellsLayout = { isActive: () => active, open: openList, openList, openNew, openEditor, openForSite, onSheetClose, onSearch, startTool, finishDraft, select, loadParcel,
    renderPlan, makePlan, exportPlan, Store, render, undo: doUndo,
    get current() { return lay; }, get tool() { return tool; }, get selected() { return sel; }, get lastExport() { return lastExport; } };
})();
