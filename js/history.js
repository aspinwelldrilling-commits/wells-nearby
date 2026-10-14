/* 🕰 Imagery history: past aerial / satellite photos over the map (like the Google Earth Pro time slider).
 * Sources (free, no key, browser CORS OK):
 *  - Esri World Imagery Wayback: every archived World Imagery release since 2014-02-20 (list from Esri's waybackconfig.json).
 *    "Changed here only" walks Esri's per-release tilemap (the "local changes" approach used by Esri's Wayback app): the
 *    tilemap for release R at the centre tile says which release that tile's pixels came from, so we hop back release by
 *    release and keep only the dates whose imagery actually differs at this spot. Capture date / provider comes from each
 *    release's metadata service.
 *  - USDA NAIP (1 m / 60 cm aerial photos) per year, served for California by CDFW (gis.wildlife.ca.gov ImageServer, one
 *    service per year, exportImage per 256 px tile).
 *  - Compare: two dates side by side with a draggable divider (pointer events, works with touch).
 * Privacy: imagery and metadata requests carry only tile coordinates / the map centre point; nothing about sites, jobs or
 * customers. */
(function () {
  'use strict';
  const A = window.WellsApp; if (!A || !A.map) return;
  const map = A.map;
  const CONFIG_URL = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';
  const WB = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/';
  const WB_TILE = WB + 'WMTS/1.0.0/default028mm/MapServer/tile/{r}/{z}/{y}/{x}';
  const NAIP = 'https://gis.wildlife.ca.gov/images/rest/services/Base_Remote_Sensing/NAIP_{year}/ImageServer';
  const NAIP_YEARS = [2005, 2009, 2010, 2012, 2014, 2016, 2018, 2020, 2022];   // natural-colour years CDFW serves (verified at Ramona)
  const KEY = 'wellsNearby.history';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- layers
  const NaipLayer = L.TileLayer.extend({
    getTileUrl(c) {
      const z = this._getZoomForUrl(), s = 2 * Math.PI * 6378137 / Math.pow(2, z), o = Math.PI * 6378137;
      const x0 = c.x * s - o, y1 = o - c.y * s;
      return `${this._base}/exportImage?bbox=${x0.toFixed(2)},${(y1 - s).toFixed(2)},${(x0 + s).toFixed(2)},${y1.toFixed(2)}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&f=image`;
    },
  });
  function naipUrl(year) { return NAIP.replace('{year}', year); }
  function makeLayer(it, pane) {
    if (it.src === 'naip') {
      const l = new NaipLayer('', { pane, maxZoom: 19, maxNativeZoom: 18, minZoom: 8, crossOrigin: 'anonymous', attribution: `NAIP ${it.year} aerial: USDA FSA, via CA Dept. of Fish &amp; Wildlife` });
      l._base = naipUrl(it.year); return l;
    }
    return L.tileLayer(WB_TILE.replace('{r}', it.r), { pane, maxZoom: 19, maxNativeZoom: 19, crossOrigin: 'anonymous', attribution: `Wayback ${it.date}: Esri World Imagery archive, Maxar, Earthstar Geographics` });
  }
  for (const [p, z] of [['histA', 250], ['histB', 251]]) { map.createPane(p); map.getPane(p).style.zIndex = z; map.getPane(p).style.pointerEvents = 'none'; }

  // ---------- timeline
  let releases = [];   // wayback items, newest first: {src:'wb', r, date, meta}
  const naipItems = NAIP_YEARS.map((y) => ({ src: 'naip', year: y, date: y + '-07-01', label: 'NAIP ' + y, id: 'naip' + y }));
  let changed = null;  // Set of release numbers that differ at the current spot (null = not known yet)
  const st = { on: false, onlyChanged: true, compare: false, side: 'a', a: null, b: null, div: 0.5 };
  try { Object.assign(st, JSON.parse(localStorage.getItem(KEY) || '{}'), { on: false, compare: false }); } catch (e) { /* */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ onlyChanged: st.onlyChanged, a: st.a, b: st.b })); } catch (e) { /* */ } };
  let cfgP = null;
  function loadConfig() {
    if (!cfgP) cfgP = fetch(CONFIG_URL).then((r) => r.json()).then((d) => {
      releases = Object.keys(d).map((k) => { const v = d[k], m = /(\d{4}-\d{2}-\d{2})/.exec(v.itemTitle || ''); return { src: 'wb', r: +k, date: m ? m[1] : '?', meta: v.metadataLayerUrl, id: 'wb' + k, label: 'Wayback ' + (m ? m[1] : k) }; })
        .filter((x) => x.date !== '?').sort((x, y) => (x.date < y.date ? 1 : -1));
    }).catch(() => { cfgP = null; releases = []; });
    return cfgP;
  }
  function items() {
    const wb = releases.filter((x) => !st.onlyChanged || !changed || changed.has(x.r));
    return naipItems.concat(wb).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  }
  const byId = (id) => naipItems.concat(releases).find((x) => x.id === id) || null;

  // Local changes: newest release -> tilemap says the release the tile at this spot really came from -> continue from the release
  // just older than that one. ~1 request per distinct image at this spot.
  const changeCache = new Map();
  let walkId = 0;
  async function walkChanges() {
    if (!releases.length) return;
    const z = Math.max(10, Math.min(18, Math.round(map.getZoom()))), c = map.getCenter();
    const n = Math.pow(2, z), x = Math.floor((c.lng + 180) / 360 * n);
    const y = Math.floor((1 - Math.log(Math.tan(c.lat * Math.PI / 180) + 1 / Math.cos(c.lat * Math.PI / 180)) / Math.PI) / 2 * n);
    const k = `${z}/${y}/${x}`;
    if (changeCache.has(k)) { changed = changeCache.get(k); render(); return; }
    const my = ++walkId, out = new Set();
    setHint('Finding dates with new imagery here…');
    let i = 0, guard = 0;
    while (i < releases.length && guard++ < 200) {
      let j;
      try {
        const r = await fetch(`${WB}MapServer/tilemap/${releases[i].r}/${z}/${y}/${x}`).then((q) => q.json());
        if (my !== walkId) return;
        if (!r || !r.data || !r.data[0]) break;
        const s = r.select && r.select[0] ? r.select[0] : releases[i].r;
        j = releases.findIndex((q) => q.r === s); if (j < i) j = i;
      } catch (e) { if (my === walkId) { changed = null; setHint('Could not check changes here — showing all dates'); render(); } return; }
      out.add(releases[j].r); i = j + 1;
    }
    changeCache.set(k, out); changed = out; setHint(''); render();
  }

  // ---------- metadata (capture date / provider for a Wayback release at the map centre)
  const metaCache = new Map();
  function metaFor(it) {
    if (it.src === 'naip') return Promise.resolve(`USDA NAIP ${it.year} aerial photo (1 m or better) · CA Dept. of Fish & Wildlife service`);
    if (!it.meta) return Promise.resolve('');
    const z = Math.round(map.getZoom()), lid = Math.max(0, Math.min(13, 23 - z)), c = map.getCenter();
    const k = `${it.r}|${lid}|${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
    if (metaCache.has(k)) return metaCache.get(k);
    const p = fetch(`${it.meta}/${lid}/query?geometry=${c.lng.toFixed(5)},${c.lat.toFixed(5)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=SRC_DATE2,NICE_DESC,SRC_RES&returnGeometry=false&f=json`)
      .then((r) => r.json()).then((d) => {
        const a = d && d.features && d.features[0] && d.features[0].attributes; if (!a) return '';
        const dt = a.SRC_DATE2 ? new Date(a.SRC_DATE2).toISOString().slice(0, 10) : '';
        return `${dt ? 'Captured ' + dt : 'Capture date n/a'}${a.NICE_DESC && a.NICE_DESC.trim() ? ' · ' + a.NICE_DESC.trim() : ''}${a.SRC_RES ? ' · ' + (+a.SRC_RES).toFixed(2) + ' m' : ''}`;
      }).catch(() => '');
    metaCache.set(k, p); return p;
  }

  // ---------- UI
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const d = L.DomUtil.create('div', 'leaflet-bar hist-ctl');
      d.innerHTML = '<button type="button" class="hist-btn" title="Past imagery (time slider)">🕰 History</button>';
      L.DomEvent.disableClickPropagation(d); return d;
    },
  });
  const ctl = new Ctl().addTo(map), btn = ctl.getContainer().querySelector('button');
  const bar = L.DomUtil.create('div', 'hist-bar hidden', map.getContainer());
  bar.innerHTML = `<div class="hb-row"><button type="button" class="hb-prev" aria-label="Older">◀</button>
      <input type="range" class="hb-range" min="0" max="0" step="1" aria-label="Imagery date">
      <button type="button" class="hb-next" aria-label="Newer">▶</button><button type="button" class="hb-x" aria-label="Close history">✕</button></div>
    <div class="hb-label"><span class="hb-sides"><button type="button" class="hb-side" data-s="a"></button><button type="button" class="hb-side" data-s="b"></button></span><b class="hb-date"></b> <span class="hb-meta muted"></span></div>
    <div class="hb-row hb-opts"><label><input type="checkbox" class="hb-changed"> Changed here only</label><label><input type="checkbox" class="hb-cmp"> Compare</label><span class="hb-hint muted"></span></div>`;
  L.DomEvent.disableClickPropagation(bar); L.DomEvent.disableScrollPropagation(bar);
  const swipe = L.DomUtil.create('div', 'hist-swipe hidden', map.getContainer());
  swipe.innerHTML = '<div class="hs-line"></div><div class="hs-knob">⇔</div>';
  const q = (s) => bar.querySelector(s), range = q('.hb-range');
  const setHint = (t) => { q('.hb-hint').textContent = t; };
  const lay = { a: null, b: null, aId: null, bId: null };

  function setLayer(side, it) {
    const k = side === 'a' ? 'aId' : 'bId', pane = side === 'a' ? 'histA' : 'histB';
    if (lay[k] === (it && it.id) && lay[side] && map.hasLayer(lay[side])) return;
    if (lay[side]) map.removeLayer(lay[side]);
    lay[side] = it ? makeLayer(it, pane).addTo(map) : null; lay[k] = it ? it.id : null;
  }
  function render() {
    btn.classList.toggle('on', st.on); bar.classList.toggle('hidden', !st.on);
    swipe.classList.toggle('hidden', !(st.on && st.compare)); bar.classList.toggle('cmp', st.compare);
    if (!st.on) { setLayer('a', null); setLayer('b', null); clip(); return; }
    const list = items(); if (!list.length) return;
    const nearest = (id) => {
      if (list.some((x) => x.id === id)) return id;
      const o = byId(id); if (!o) return null;
      let best = list[0]; for (const x of list) if (Math.abs(Date.parse(x.date) - Date.parse(o.date)) < Math.abs(Date.parse(best.date) - Date.parse(o.date))) best = x;
      return best.id;
    };
    st.a = nearest(st.a) || list.filter((x) => x.src === 'wb')[0]?.id || list[0].id;
    st.b = nearest(st.b) || list[list.length - 1].id;
    const cur = st.compare ? st[st.side] : st.a, idx = Math.max(0, list.findIndex((x) => x.id === cur));
    range.max = list.length - 1; range.value = idx;
    const it = list[idx];
    q('.hb-date').textContent = `${it.src === 'naip' ? '✈ NAIP ' + it.year : '🛰 Wayback ' + it.date}  (${idx + 1}/${list.length})`;
    q('.hb-changed').checked = st.onlyChanged; q('.hb-cmp').checked = st.compare;
    for (const b of bar.querySelectorAll('.hb-side')) { const o = byId(st[b.dataset.s]); b.textContent = (b.dataset.s === 'a' ? 'L: ' : 'R: ') + (o ? (o.src === 'naip' ? 'NAIP ' + o.year : o.date) : '—'); b.classList.toggle('act', st.side === b.dataset.s); }
    setLayer('a', byId(st.a)); setLayer('b', st.compare ? byId(st.b) : null); clip();
    const m = q('.hb-meta'); m.textContent = ''; const tok = it.id;
    metaFor(it).then((t) => { if ((st.compare ? st[st.side] : st.a) === tok) m.textContent = t; });
    save();
  }
  function clip() {
    const p = map.getPane('histB');
    if (!(st.on && st.compare)) { p.style.clip = ''; return; }
    const sz = map.getSize(), nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint(sz), x = map.containerPointToLayerPoint([sz.x * st.div, 0]).x;
    p.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
    swipe.style.left = (sz.x * st.div) + 'px';
  }
  range.addEventListener('input', () => { const it = items()[+range.value]; if (!it) return; st[st.compare ? st.side : 'a'] = it.id; render(); });
  q('.hb-prev').onclick = () => { if (+range.value > 0) { range.value = +range.value - 1; range.dispatchEvent(new Event('input')); } };
  q('.hb-next').onclick = () => { if (+range.value < +range.max) { range.value = +range.value + 1; range.dispatchEvent(new Event('input')); } };
  q('.hb-x').onclick = () => { st.on = false; render(); };
  q('.hb-changed').onchange = (e) => { st.onlyChanged = e.target.checked; if (st.onlyChanged) walkChanges(); render(); };
  q('.hb-cmp').onchange = (e) => { st.compare = e.target.checked; st.side = 'b'; render(); };
  for (const b of bar.querySelectorAll('.hb-side')) b.onclick = () => { st.side = b.dataset.s; render(); };
  btn.onclick = async () => {
    st.on = !st.on; render(); if (!st.on) return;
    setHint('Loading dates…'); await loadConfig(); setHint(releases.length ? '' : 'Wayback list unavailable — NAIP years only');
    render(); if (st.onlyChanged) walkChanges();
  };
  // divider drag (mouse + touch through pointer events; the map must not pan while dragging)
  L.DomEvent.disableClickPropagation(swipe);
  let drag = false;
  swipe.addEventListener('pointerdown', (e) => { drag = true; swipe.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); map.dragging.disable(); });
  swipe.addEventListener('pointermove', (e) => {
    if (!drag) return; const r = map.getContainer().getBoundingClientRect();
    st.div = Math.max(0.03, Math.min(0.97, (e.clientX - r.left) / r.width)); clip(); e.preventDefault();
  });
  const end = () => { if (drag) { drag = false; map.dragging.enable(); } };
  swipe.addEventListener('pointerup', end); swipe.addEventListener('pointercancel', end);
  map.on('move zoom resize viewreset zoomend', clip);
  let mvT = null;
  map.on('moveend', () => { if (!st.on) return; clearTimeout(mvT); mvT = setTimeout(() => { if (st.onlyChanged) walkChanges(); else render(); }, 400); });

  /** For the septic plot plan: the historical image shown on the left / only side, as a {z}/{y}/{x} template or a function. */
  function exportSource() {
    if (!st.on) return null;
    const it = byId(st.a); if (!it) return null;
    if (it.src === 'wb') return { tpl: WB_TILE.replace('{r}', it.r), credit: `Imagery: Esri World Imagery Wayback ${it.date} (archived release; Maxar, Earthstar Geographics).`, maxZ: 19 };
    const base = naipUrl(it.year);
    return { tpl: (z, y, x) => NaipLayer.prototype.getTileUrl.call({ _base: base, _getZoomForUrl: () => z }, { x, y }), credit: `Imagery: USDA NAIP ${it.year} aerial (via CA Dept. of Fish & Wildlife).`, maxZ: 18 };
  }
  window.WellsHistory = { exportSource, state: st, items, loadConfig, walkChanges, get changed() { return changed; }, render, NAIP_YEARS };
})();
