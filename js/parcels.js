/* Wells Nearby — property lines (SanGIS / County "Assessor Parcels", DPLU_Map layer 0) as a map overlay.
 * Server-rendered: the county MapServer's export endpoint draws the parcel outlines in bright yellow (dynamicLayers
 * restyle) into 512 px transparent PNG tiles; APN labels (layer 1, white with black halo) are added at zoom >= 18.
 * Shown from zoom 15 (the service draws parcels only below 1:36,000); a "zoom in" hint appears when zoomed out.
 * Tap the map at zoom >= 16 with the layer on to see the APN (+ outline) of the tapped parcel in the tap popup.
 * On/off + opacity are remembered on the device (localStorage). Tiles are not cached by the service worker (the
 * county sends no-store and they only make sense online). */
(function () {
  'use strict';
  const C = window.WELLS_CONFIG, A = window.WellsApp, map = A.map;
  const P = C.parcelLines;
  const KEY = 'wellsNearby.parcels';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } })();
  const st = { on: !!saved.on, opacity: Number.isFinite(saved.opacity) ? Math.max(0, Math.min(100, saved.opacity)) : P.defaultOpacity };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ on: st.on, opacity: st.opacity })); } catch (e) { /* private mode */ } };

  const line = { type: 'esriSLS', style: 'esriSLSSolid', color: P.color, width: P.widthPt };
  const L0 = { id: 0, source: { type: 'mapLayer', mapLayerId: 0 },
    drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSFS', style: 'esriSFSNull', outline: line } } } };
  const L1 = { id: 1, source: { type: 'mapLayer', mapLayerId: 1 },
    drawingInfo: { renderer: { type: 'simple', symbol: { type: 'esriSFS', style: 'esriSFSNull', outline: { type: 'esriSLS', style: 'esriSLSNull', width: 0 } } },
      showLabels: true, labelingInfo: [{ labelExpression: '[APN_8]', labelPlacement: 'esriServerPolygonPlacementAlwaysHorizontal', where: "MULTI <> 'Y'",
        minScale: 0, maxScale: 0, symbol: { type: 'esriTS', color: [255, 255, 255, 255], haloColor: [0, 0, 0, 255], haloSize: 1.5,
          font: { family: 'Arial', size: 9, weight: 'bold' }, verticalAlignment: 'middle', horizontalAlignment: 'center' } }] } };
  const DL_LINES = encodeURIComponent(JSON.stringify([L0]));
  const DL_LABELS = encodeURIComponent(JSON.stringify([L0, L1]));
  const R = 6378137, O = Math.PI * R;
  const scale = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));  // crisper lines on phones

  map.createPane('parcels');
  map.getPane('parcels').style.zIndex = 350;          // above imagery/labels (200), below wells & popups
  map.getPane('parcels').style.pointerEvents = 'none';

  const ParcelTiles = L.TileLayer.extend({
    getTileUrl(c) {
      const n = Math.pow(2, c.z) * 256 / this.options.tileSize, s = 2 * O / n;
      const bbox = [-O + c.x * s, O - (c.y + 1) * s, -O + (c.x + 1) * s, O - c.y * s].map((v) => v.toFixed(2)).join(',');
      const labels = c.z >= P.labelZoom;
      const px = this.options.tileSize * scale;
      return `${P.exportUrl}?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${px},${px}&dpi=${96 * scale}&format=png32&transparent=true`
        + `&layers=show:${labels ? '0,1' : '0'}&dynamicLayers=${labels ? DL_LABELS : DL_LINES}&f=image`;
    },
  });
  const layer = new ParcelTiles('', { tileSize: 512, minZoom: P.minZoom, maxZoom: 19, pane: 'parcels', opacity: st.opacity / 100,
    attribution: 'Parcels &copy; SanGIS / County of San Diego', updateWhenIdle: true, keepBuffer: 1 });

  // ---------- control (top-left, under the zoom buttons) ----------
  const Ctl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const d = L.DomUtil.create('div', 'leaflet-bar parcel-ctl');
      d.innerHTML = `<button type="button" class="pc-btn" aria-pressed="false" title="Property lines (parcels)">▦ Lines</button>
        <div class="pc-panel"><label class="pc-op">Opacity <output class="pc-val"></output>
          <input type="range" class="pc-range" min="0" max="100" step="5" aria-label="Property line opacity"></label>
          <div class="pc-hint"></div></div>`;
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      return d;
    },
  });
  const ctl = new Ctl().addTo(map);
  const el = ctl.getContainer(), btn = el.querySelector('.pc-btn'), range = el.querySelector('.pc-range'), val = el.querySelector('.pc-val'), hint = el.querySelector('.pc-hint');

  function render() {
    el.classList.toggle('on', st.on);
    btn.setAttribute('aria-pressed', String(st.on));
    range.value = String(st.opacity); val.textContent = st.opacity + '%';
    const z = map.getZoom();
    hint.textContent = !st.on ? '' : z < P.minZoom ? '🔍 Zoom in to see property lines' : z < P.tapZoom ? '' : 'Tap map for APN';
    hint.classList.toggle('warn', st.on && z < P.minZoom);
  }
  function apply() {
    if (st.on && !map.hasLayer(layer)) layer.addTo(map);
    if (!st.on && map.hasLayer(layer)) { map.removeLayer(layer); outline.clearLayers(); }
    layer.setOpacity(st.opacity / 100);
    render();
  }
  btn.onclick = () => { st.on = !st.on; save(); apply(); };
  range.oninput = () => { st.opacity = +range.value; layer.setOpacity(st.opacity / 100); render(); };
  range.onchange = () => { st.opacity = +range.value; save(); };
  map.on('zoomend', render);

  // ---------- tap -> APN of the tapped parcel (adds a line to the map-tap popup) ----------
  const outline = L.layerGroup().addTo(map);
  const fmtApn = (a) => { const s = String(a || '').replace(/\D/g, ''); return s.length === 10 ? `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6, 8)}-${s.slice(8)}` : String(a || ''); };
  let tapSeq = 0;
  map.on('click', async (e) => {
    if (!st.on || map.getZoom() < P.tapZoom) return;
    const seq = ++tapSeq;
    const q = new URLSearchParams({ geometry: `${e.latlng.lng},${e.latlng.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'APN,ACREAGE', returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' });
    let html;
    try {
      const j = await (await fetch(C.parcels.url + '?' + q)).json();
      const f = (j.features || [])[0];
      if (seq !== tapSeq) return;
      outline.clearLayers();
      if (f) {
        html = `<div class="pc-apn">Parcel APN <b>${fmtApn(f.attributes.APN)}</b>${f.attributes.ACREAGE ? ` · ${f.attributes.ACREAGE} ac` : ''}</div>`;
        if (f.geometry && f.geometry.rings) L.polygon(f.geometry.rings.map((r) => r.map(([x, y]) => [y, x])), { color: '#22d3ee', weight: 3, fill: false, interactive: false }).addTo(outline);
      } else html = '<div class="pc-apn muted">No parcel here</div>';
    } catch (err) { if (seq === tapSeq) html = '<div class="pc-apn muted">Parcel lookup failed (offline?)</div>'; }
    const pop = map._popup;  // the "Search here" popup opened by the app for this tap
    if (html && pop && map.hasLayer(pop) && pop.getLatLng().equals(e.latlng)) {
      const box = pop.getElement() && pop.getElement().querySelector('.popup');
      if (box) { box.insertAdjacentHTML('beforeend', html); pop.setContent(box); }  // same node: the app's button handler stays
    }
  });
  map.on('popupclose', () => outline.clearLayers());

  apply();
  window.WellsParcels = { layer, get state() { return { ...st }; }, set(on, opacity) { if (on != null) st.on = !!on; if (opacity != null) st.opacity = opacity; save(); apply(); } };
})();
