/* Wells Nearby — "My Jobs": the contractor's own past jobs from a Google Earth export (.kmz / .kml), or the matched
 * .json made from it on the office computer (job drawings + derived well point + matched County permit / WCR).
 * PRIVATE BY DESIGN: the file is read and parsed entirely in this browser and stored ONLY on this device (IndexedDB,
 * its own database "wells-nearby-myjobs"). Nothing about the jobs is ever sent to any server; the only network use is the
 * normal map tiles and, when you tap "Wells nearby" in a job popup, the usual coordinate search.
 * KMZ = zip: read with a tiny zip reader + the browser's DecompressionStream('deflate-raw'); KML read with DOMParser. */
(function (global) {
  'use strict';
  const A = global.WellsApp;
  if (!A || !A.map || typeof L === 'undefined') return;
  const map = A.map;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => (global.WellsSites && global.WellsSites.toast ? global.WellsSites.toast(m) : console.log(m));

  // ------------------------------------------------------------------ device storage (own DB: never touches the sites DB)
  const DB = 'wells-nearby-myjobs', STORE = 'data', KEY = 'jobs';
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(STORE, mode), q = fn(t.objectStore(STORE));
      t.oncomplete = () => res(q && 'result' in q ? q.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const Store = { get: () => idb('readonly', (s) => s.get(KEY)), put: (v) => idb('readwrite', (s) => s.put(v, KEY)), del: () => idb('readwrite', (s) => s.delete(KEY)) };
  const PREF = 'wellsNearby.myJobs';
  const pref = (() => { try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch (e) { return {}; } })();
  const savePref = () => { try { localStorage.setItem(PREF, JSON.stringify({ on: pref.on !== false, year: pref.year || '' })); } catch (e) { /* */ } };

  // ------------------------------------------------------------------ KMZ (zip) reader
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot open .kmz files — export as .kml instead');
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  async function unzipKml(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a valid .kmz (zip) file');
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
      entries.push({ name, method, csize, off }); p += 46 + nl + xl + cl;
    }
    const e = entries.find((x) => /(^|\/)doc\.kml$/i.test(x.name)) || entries.find((x) => /\.kml$/i.test(x.name));
    if (!e) throw new Error('no .kml inside the .kmz');
    const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
    const data = u8.subarray(start, start + e.csize);
    const raw = e.method === 0 ? data : e.method === 8 ? await inflateRaw(data) : null;
    if (!raw) throw new Error('unsupported compression in .kmz');
    return new TextDecoder().decode(raw);
  }

  // ------------------------------------------------------------------ KML -> jobs (same rules as the office matcher)
  const YEAR_RE = /\b(19|20)\d{2}\b/;
  const isCont = (e) => e.localName === 'Folder' || e.localName === 'Document';
  const kids = (e) => [...e.children].filter((c) => isCont(c) || c.localName === 'Placemark');
  const nameOf = (e) => { const n = [...e.children].find((c) => c.localName === 'name'); return n ? n.textContent.trim() : ''; };
  const child = (e, ln) => [...e.children].find((c) => c.localName === ln);
  function kmlColor(s) {
    s = String(s || '').trim().replace(/^#/, '');
    if (s.length !== 8) return null;
    return { c: '#' + s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4), o: Math.round(parseInt(s.slice(0, 2), 16) / 2.55) / 100 };
  }
  function styleOf(st) {
    const o = {};
    const ls = child(st, 'LineStyle'), ps = child(st, 'PolyStyle');
    if (ls) { const c = kmlColor((child(ls, 'color') || {}).textContent); if (c) { o.c = c.c; o.o = c.o; } const w = parseFloat((child(ls, 'width') || {}).textContent); if (w) o.w = Math.round(w * 10) / 10; }
    if (ps) { const c = kmlColor((child(ps, 'color') || {}).textContent); if (c) { o.f = c.c; o.fo = c.o; } if (((child(ps, 'fill') || {}).textContent || '1').trim() === '0') o.fo = 0; }
    return o;
  }
  function coordsOf(el) {
    const t = el.getElementsByTagNameNS('*', 'coordinates')[0]; if (!t) return [];
    const out = [];
    for (const s of t.textContent.trim().split(/\s+/)) { const p = s.split(','); const lo = parseFloat(p[0]), la = parseFloat(p[1]); if (Number.isFinite(la) && Number.isFinite(lo)) out.push([+la.toFixed(7), +lo.toFixed(7)]); }
    return out;
  }
  const M_LAT = 111320;
  const distM = (a, b) => { const k = Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180); return Math.hypot((a[0] - b[0]) * M_LAT, (a[1] - b[1]) * M_LAT * k); };
  function ringInfo(pts) {
    const q = pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts.slice(0, -1) : pts;
    const c = [q.reduce((s, p) => s + p[0], 0) / q.length, q.reduce((s, p) => s + p[1], 0) / q.length];
    const r = q.reduce((s, p) => s + distM(c, p), 0) / q.length;
    return { c, r, closed: pts.length > 3 && distM(pts[0], pts[pts.length - 1]) < Math.max(0.5, r * 0.2) };
  }
  const WELL_RE = /\bwell\b/i;
  const WELL_EXCL = /radi|raidus|raius|radus|setback|\d+\s*(feet|foot|ft)\b|\bfrom\b|away|measure|neighbo|nighbo|if needed|wire|line\b|fill/i;
  const RADIUS_RE = /radi|raidus|raius|radus|setback|foor|circle/i;
  const PROPOSED_RE = /pro?po?e?sd|propos|propoesd|proposd/i;
  function wellRank(n, destruction) {
    n = n.toLowerCase();
    if (/updated|new proposed|proposed new|new well/.test(n)) return 0;
    if (/destr/.test(n)) return destruction ? 0 : 2;
    if (/drilled/.test(n)) return 1;
    if (PROPOSED_RE.test(n)) return /#\s*2|second|2nd/.test(n) ? 1.5 : 1;
    if (/existin/.test(n)) return destruction ? 0.5 : 2;
    if (/possible|second/.test(n)) return 3;
    return 2.5;
  }
  const r7 = (v) => +v.toFixed(7);
  function deriveWell(pms, destruction) {
    const cands = [];
    pms.forEach((p, i) => {
      if (p.t === 'T') { if (WELL_RE.test(p.n) || !p.n) cands.push([wellRank(p.n, destruction), i, p.c[0], p.n]); return; }
      if (!WELL_RE.test(p.n)) return;
      if (WELL_EXCL.test(p.n) && !/^\s*(new|updated)\b/i.test(p.n)) return;
      const ri = ringInfo(p.c);
      if (p.c.length >= 3 && ri.r <= 8) cands.push([wellRank(p.n, destruction), i, ri.c, p.n]);
    });
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const wells = cands.map((c) => ({ lat: r7(c[2][0]), lon: r7(c[2][1]), name: c[3] }));
    if (cands.length) return { pt: [r7(cands[0][2][0]), r7(cands[0][2][1])], src: `well drawing (${cands[0][3]})`, wells };
    const cluster = (items) => { let best = null; for (const [c, w] of items) { const n = items.filter(([c2]) => distM(c, c2) < 3).length; if (!best || n > best[0] || (n === best[0] && w < best[2])) best = [n, c, w]; } return best; };
    const rings = [];
    for (const p of pms) {
      if (p.t === 'T' || p.c.length < 8) continue;
      const ri = ringInfo(p.c);
      if (ri.closed && RADIUS_RE.test(p.n) && !/neighbo|nighbo/i.test(p.n) && ri.r > 5 && ri.r < 400) rings.push([ri.c, ri.r]);
    }
    if (rings.length) { const b = cluster(rings); return { pt: [r7(b[1][0]), r7(b[1][1])], src: 'centre of radius circle', wells: [] }; }
    const ends = [];
    for (const p of pms) if (p.t === 'L' && p.c.length >= 2 && p.c.length <= 3) ends.push([p.c[0], 0], [p.c[p.c.length - 1], 0]);
    if (ends.length) { const b = cluster(ends); if (b[0] >= 2) return { pt: [r7(b[1][0]), r7(b[1][1])], src: `common end of ${b[0]} measurement lines (approx.)`, wells: [] }; }
    const all = pms.flatMap((p) => p.c);
    if (all.length) return { pt: [r7(all.reduce((s, q) => s + q[0], 0) / all.length), r7(all.reduce((s, q) => s + q[1], 0) / all.length)], src: 'centre of all drawings (approx., no well drawn)', wells: [] };
    return { pt: null, src: 'no geometry', wells: [] };
  }
  function jobKind(name, pms) {
    const nm = pms.map((p) => p.n).join(' ');
    const d = /destr/i.test(name) || /destr/i.test(nm), nw = PROPOSED_RE.test(nm) || /new well|drilled/i.test(nm);
    return d && nw ? 'destruction+new' : d ? 'destruction' : 'new';
  }
  function sigOf(pms) {   // cheap stable signature of the drawings (duplicate folders)
    let h = 0; const s = JSON.stringify(pms.map((p) => [p.t, p.c]));
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16) + ':' + s.length;
  }
  function parseKml(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('the file is not valid KML');
    const styles = {}, maps = {};
    for (const st of xml.getElementsByTagNameNS('*', 'Style')) if (st.getAttribute('id')) styles[st.getAttribute('id')] = styleOf(st);
    for (const sm of xml.getElementsByTagNameNS('*', 'StyleMap')) {
      for (const pr of [...sm.children].filter((c) => c.localName === 'Pair')) if (((child(pr, 'key') || {}).textContent || '').trim() === 'normal') maps[sm.getAttribute('id')] = ((child(pr, 'styleUrl') || {}).textContent || '').trim().replace(/^#/, '');
    }
    const styleFor = (pm) => {
      const o = {}; const u = ((child(pm, 'styleUrl') || {}).textContent || '').trim();
      if (u.startsWith('#')) { const id = maps[u.slice(1)] || u.slice(1); Object.assign(o, styles[id] || {}); }
      const inl = child(pm, 'Style'); if (inl) Object.assign(o, styleOf(inl));
      return o;
    };
    const geoms = (pm) => {
      const g = [];
      for (const el of pm.getElementsByTagNameNS('*', '*')) {
        if (el.localName === 'LineString') g.push(['L', coordsOf(el)]);
        else if (el.localName === 'Polygon') { const ob = el.getElementsByTagNameNS('*', 'outerBoundaryIs')[0]; if (ob) g.push(['P', coordsOf(ob)]); }
        else if (el.localName === 'Point') g.push(['T', coordsOf(el)]);
      }
      return g.filter((x) => x[1].length);
    };
    const pmList = (c) => {
      const list = c.localName === 'Placemark' ? [c] : [...c.getElementsByTagNameNS('*', 'Placemark')];
      const out = [];
      for (const pm of list) { const st = styleFor(pm); for (const [t, co] of geoms(pm)) { const d = { n: nameOf(pm), t, c: co }; if (Object.keys(st).length) d.s = st; out.push(d); } }
      return out;
    };
    let node = xml.documentElement;
    for (;;) { const k = kids(node); if (k.length === 1 && isCont(k[0]) && !YEAR_RE.test(nameOf(k[0]))) node = k[0]; else break; }
    const jobs = [];
    const add = (name, group, year, el) => {
      const pms = pmList(el), kind = jobKind(name, pms), w = deriveWell(pms, kind === 'destruction');
      jobs.push({ key: (group + '/' + name).toLowerCase(), name, group, year, kind, well: w.pt ? { lat: w.pt[0], lon: w.pt[1], src: w.src } : null, wells: w.wells, pm: pms, sig: pms.length ? sigOf(pms) : '' });
    };
    for (const top of kids(node)) {
      const tn = nameOf(top), y = tn.match(YEAR_RE);
      if (y && isCont(top)) for (const ch of kids(top)) add(nameOf(ch) || '(unnamed)', tn, +y[0], ch);
      else add(tn || '(unnamed)', tn || '(unnamed)', null, top);
    }
    markDupes(jobs);
    return jobs;
  }
  function markDupes(jobs) {
    const seen = new Map();
    for (const j of jobs) {
      if (!j.pm || !j.pm.length) { j.empty = true; continue; }
      const s = j.sig || (j.sig = sigOf(j.pm)), k = j.group + '|' + s;
      if (seen.has(k)) j.dupOf = seen.get(k); else seen.set(k, j.key);
    }
  }

  // ------------------------------------------------------------------ import / remove
  let data = null;   // {source, imported, hasMatches, jobs:[...]}
  async function importFile(file) {
    const nm = file.name || '';
    let jobs, hasMatches = false;
    if (/\.json$/i.test(nm) || file.type === 'application/json') {
      const j = JSON.parse(await file.text());
      if (!j || j.kind !== 'my-jobs' || !Array.isArray(j.jobs)) throw new Error('this .json is not a My Jobs file');
      jobs = j.jobs.filter((x) => x && x.name);
      for (const x of jobs) { x.pm = Array.isArray(x.pm) ? x.pm : []; delete x.sig; }
      markDupes(jobs.map((x) => (delete x.dupOf, delete x.empty, x)));
      hasMatches = jobs.some((x) => 'match' in x);
    } else {
      const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      const text = u8[0] === 0x50 && u8[1] === 0x4b ? await unzipKml(buf) : new TextDecoder().decode(buf);
      jobs = parseKml(text);
      // keep matches from an earlier .json import (same job key)
      if (data && data.hasMatches) {
        const old = new Map(data.jobs.map((x) => [x.key, x]));
        for (const x of jobs) { const o = old.get(x.key); if (o) for (const k of ['match', 'alternates', 'confidence', 'parcel', 'notes', 'stateWcrOnly']) if (k in o) x[k] = o[k]; }
        hasMatches = jobs.some((x) => 'match' in x);
      }
    }
    if (!jobs.length) throw new Error('no jobs found in the file');
    const rec = { source: nm, imported: new Date().toISOString(), hasMatches, jobs };
    await Store.put(rec);
    data = rec; pref.on = true; pref.year = ''; savePref();
    render(); if (!map.hasLayer(group)) group.addTo(map);
    const c = counts();
    fitAll();
    return c;
  }
  async function removeAll() {
    await Store.del(); data = null;
    jobsLayer.clearLayers(); drawLayer.clearLayers(); map.closePopup();
    renderCtl();
  }
  const visibleJobs = () => (data ? data.jobs.filter((j) => !j.dupOf && !j.empty && j.well && (!pref.year || String(j.year || j.group) === pref.year)) : []);
  function counts() {
    const all = data ? data.jobs : [];
    return { jobs: all.filter((j) => !j.dupOf && !j.empty && j.well).length, dup: all.filter((j) => j.dupOf).length, empty: all.filter((j) => j.empty).length,
      lines: all.filter((j) => !j.dupOf).reduce((s, j) => s + j.pm.length, 0), noWell: all.filter((j) => !j.empty && !j.well).length };
  }

  // ------------------------------------------------------------------ map layers
  map.createPane('myJobsDraw').style.zIndex = 420;
  const group = L.layerGroup(), jobsLayer = L.layerGroup().addTo(group), drawLayer = L.layerGroup().addTo(group);
  if (A.layersCtl) A.layersCtl.addOverlay(group, '<span class="lg lg-myjobs"></span> My Jobs (this device)');
  const CONF = { high: ['#16a34a', 'High'], medium: ['#f59e0b', 'Medium'], low: ['#f97316', 'Low'], none: ['#64748b', 'No match'] };
  const DRAW_MIN_ZOOM = 15, CLUSTER_MAX_ZOOM = 13;
  const color = (j) => (data && data.hasMatches ? (CONF[j.confidence || (j.match && j.match.confidence) || 'none'] || CONF.none)[0] : '#2563eb');
  const jobIcon = (j) => L.divIcon({ className: '', html: `<div class="mj-pin${/destr/.test(j.kind) ? ' destr' : ''}" style="background:${color(j)}">${/destr/.test(j.kind) ? '✕' : '⛏'}</div>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });

  function render() {
    jobsLayer.clearLayers(); drawLayer.clearLayers();
    renderCtl();
    if (!data || !map.hasLayer(group)) return;
    const js = visibleJobs(), z = map.getZoom();
    if (z <= CLUSTER_MAX_ZOOM) {   // declutter: one bubble per ~56 px cell
      const cells = new Map(), cs = 56;
      for (const j of js) { const p = map.project([j.well.lat, j.well.lon], z); const k = Math.floor(p.x / cs) + ':' + Math.floor(p.y / cs); (cells.get(k) || cells.set(k, []).get(k)).push(j); }
      for (const g of cells.values()) {
        if (g.length === 1) { addJobMarker(g[0]); continue; }
        const lat = g.reduce((s, j) => s + j.well.lat, 0) / g.length, lon = g.reduce((s, j) => s + j.well.lon, 0) / g.length;
        const sz = Math.min(44, 26 + Math.log2(g.length) * 5);
        L.marker([lat, lon], { icon: L.divIcon({ className: '', html: `<div class="mj-cluster" style="width:${sz}px;height:${sz}px">${g.length}</div>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] }), title: `${g.length} jobs`, zIndexOffset: 1500 })
          .on('click', () => map.fitBounds(L.latLngBounds(g.map((j) => [j.well.lat, j.well.lon])).pad(0.4), { maxZoom: 16 })).addTo(jobsLayer);
      }
    } else js.forEach(addJobMarker);
    if (openKey) jobsLayer.eachLayer((m) => { if (m._mjKey === openKey && !map._popup) m.openPopup(); });   // keep a job popup open across a zoom
    if (z >= DRAW_MIN_ZOOM) {   // all jobs' drawings (Leaflet clips off-screen paths), so panning never re-renders
      for (const j of js) {
        for (const p of j.pm) {
          const s = p.s || {}, col = s.c || '#ffffff';
          const opt = { pane: 'myJobsDraw', color: col, opacity: s.o != null ? Math.max(0.5, s.o) : 0.95, weight: Math.max(2, Math.min(5, s.w || 2)), bubblingMouseEvents: false };
          let lyr;
          if (p.t === 'P') lyr = L.polygon(p.c, { ...opt, fillColor: s.f || col, fillOpacity: s.fo != null ? Math.min(0.35, s.fo) : 0.15 });
          else if (p.t === 'T') lyr = L.circleMarker(p.c[0], { ...opt, radius: 4, fillOpacity: 1 });
          else lyr = L.polyline(p.c, opt);
          if (p.n) lyr.bindTooltip(esc(p.n), { sticky: true, className: 'mj-tip' });
          lyr.addTo(drawLayer);
        }
      }
    }
  }
  function addJobMarker(j) {
    const m = L.marker([j.well.lat, j.well.lon], { icon: jobIcon(j), title: j.name, zIndexOffset: 1800 })
      .bindPopup(() => popup(j), { maxWidth: 310, maxHeight: Math.max(260, (document.getElementById('map').clientHeight || 400) - 90) })
      .on('popupopen', () => { openKey = j.key; }).on('popupclose', () => { setTimeout(() => { if (!map._popup || !map.hasLayer(map._popup)) openKey = null; }, 0); });
    m._mjKey = j.key;
    m.addTo(jobsLayer);
  }
  let openKey = null;
  const fmtDate = (s) => (s ? String(s).slice(0, 10) : '');
  function matchHtml(j) {
    if (!data.hasMatches) return '<div class="muted small">Permit / WCR matches appear here after importing the matched <b>my-jobs.json</b>.</div>';
    const m = j.match, conf = j.confidence || (m && m.confidence) || 'none', [col, label] = CONF[conf] || CONF.none;
    let h = `<div class="mj-conf" style="border-color:${col}"><b style="color:${col}">● ${label}</b>${m ? ` · permit <b>${esc(m.permit)}</b>` : ' — no permit matched'}</div>`;
    if (m) {
      h += `<div class="mj-why">${esc(m.reason || '')}</div><table>
        ${m.apn ? `<tr><td>APN</td><td>${esc(m.apn)}</td></tr>` : ''}
        ${m.opened || m.firstDoc ? `<tr><td>${m.opened ? 'Opened' : 'First doc'}</td><td>${esc(fmtDate(m.opened || m.firstDoc))}</td></tr>` : ''}
        ${m.typeWork || m.status ? `<tr><td>Work</td><td>${esc(m.typeWork || (m.destruction ? 'Destruction' : ''))}${m.status ? ` <small>(${esc(m.status)})</small>` : ''}</td></tr>` : ''}
        ${m.distM != null ? `<tr><td>Distance</td><td>${m.distM} m from the well point${m.apnMatch ? ' (same parcel)' : ''}</td></tr>` : ''}
        ${m.wcrStatusText ? `<tr><td>County WCR</td><td>${esc(m.wcrStatusText)}</td></tr>` : ''}
        ${m.ocr && m.ocr.depthFt ? `<tr><td>Depth</td><td>${esc(m.ocr.depthFt)} ft <small>(OCR)</small></td></tr>` : ''}
      </table>`;
      const links = [];
      const isWcr = /^(readable|partial|unreadable|library_wcr|destruction_wcr)$/.test(m.wcrStatus || '');
      if (m.wcrDocUrl) links.push(`<li><a href="${esc(m.wcrDocUrl)}" target="_blank" rel="noopener">${isWcr ? '📋 County WCR (drillers report)' : '📄 Permit file (no WCR found)'}${m.wcrPage ? ` · page ${esc(m.wcrPage)}` : ''}</a></li>`);
      for (const d of (m.docs || []).slice().reverse()) if (d.url !== m.wcrDocUrl) links.push(`<li><a href="${esc(d.url)}" target="_blank" rel="noopener">📄 ${esc(d.label || 'document')}</a> <small class="muted">${esc(d.date || '')}</small></li>`);
      const sw = m.stateWcr;
      if (sw) links.push(`<li>${sw.pdf ? `<a href="${esc(sw.pdf)}" target="_blank" rel="noopener">🏛 State WCR ${esc(sw.wcr)}</a>` : `🏛 State WCR <b>${esc(sw.wcr)}</b>`} <small class="muted">${esc(sw.ended || '')}${sw.driller ? ' · ' + esc(sw.driller) : ''}</small></li>`);
      if (links.length) h += `<ul class="doclist">${links.join('')}</ul>`;
    }
    const so = j.stateWcrOnly;
    if (!m && so) h += `<div class="small">Nearby state WCR <b>${esc(so.wcr)}</b> ${esc(so.ended || '')}${so.pdf ? ` · <a href="${esc(so.pdf)}" target="_blank" rel="noopener">PDF</a>` : ''}</div>`;
    if ((j.alternates || []).length) h += `<details class="mj-alt"><summary>Other candidates (${j.alternates.length})</summary><ul>${j.alternates.map((a) => `<li><b>${esc(a.permit)}</b> <small>${esc(a.confidence)} · ${esc(a.reason)}</small></li>`).join('')}</ul></details>`;
    if ((j.notes || []).length) h += `<div class="muted small">${j.notes.map(esc).join(' · ')}</div>`;
    return h;
  }
  function popup(j) {
    const box = document.createElement('div'); box.className = 'popup mj-popup';
    const others = (j.wells || []).length > 1 ? `<div class="muted small">${j.wells.length} wells drawn: ${j.wells.map((w) => esc(w.name)).join(', ')}</div>` : '';
    box.innerHTML = `<div class="mj-tag">My job · on this device only</div><h3>${esc(j.name)}</h3>
      <div class="small">${esc(j.year ? 'Drilling ' + j.year : j.group)}${j.kind !== 'new' ? ` · <b>${esc(j.kind === 'destruction' ? 'well destruction' : 'destruction + new well')}</b>` : ''}</div>
      ${j.parcel && (j.parcel.apn || j.parcel.address) ? `<div class="small">APN ${esc(j.parcel.apn || '—')}${j.parcel.address ? ' · ' + esc(j.parcel.address) : ''}</div>` : ''}
      <div class="muted small">Well point: ${j.well.lat.toFixed(6)}, ${j.well.lon.toFixed(6)} · ${esc(j.well.src)}</div>${others}
      ${matchHtml(j)}
      <div class="site-actions"><button type="button" class="small mj-near">💧 Wells nearby</button><button type="button" class="small mj-zoom">🔍 Drawings</button>
        <a class="small btnlink" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${j.well.lat.toFixed(6)},${j.well.lon.toFixed(6)}">🧭 Directions</a></div>`;
    box.querySelector('.mj-near').onclick = (e) => { e.stopPropagation(); map.closePopup(); A.setLocation(j.well.lat, j.well.lon, 'my job'); };
    box.querySelector('.mj-zoom').onclick = (e) => { e.stopPropagation(); zoomJob(j); };
    L.DomEvent.disableClickPropagation(box);
    return box;
  }
  function zoomJob(j) {
    const pts = j.pm.flatMap((p) => p.c);
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 19 }); else map.setView([j.well.lat, j.well.lon], 18);
  }
  function fitAll() { const js = visibleJobs(); if (js.length) map.fitBounds(L.latLngBounds(js.map((j) => [j.well.lat, j.well.lon])).pad(0.1), { maxZoom: 16 }); }
  let rT = null;
  // markers are clustered on the absolute pixel grid of the zoom level, so only a zoom change needs a re-render (a pan,
  // e.g. a popup auto-panning into view, must not rebuild the markers: that would close the popup)
  map.on('zoomend', () => { clearTimeout(rT); rT = setTimeout(render, 120); });
  map.on('overlayadd overlayremove', (e) => { if (e.layer === group) { pref.on = e.type === 'overlayadd'; savePref(); render(); } });

  // ------------------------------------------------------------------ control (map, top-left, like 🚽 Sewer)
  const st = document.createElement('style');
  st.textContent = `.lg-myjobs{border-radius:50%;background:#2563eb;border:2px solid #fff;box-shadow:0 0 0 1px #999}
.myjobs-ctl{background:#fff;border-radius:8px;overflow:hidden}
.myjobs-ctl .mj-btn{display:block;font-size:14px;font-weight:600;padding:8px 10px;min-height:40px;border:0;border-radius:0;background:#fff;color:#0f172a;white-space:nowrap}
.myjobs-ctl.on .mj-btn{background:#2563eb;color:#fff}
.myjobs-ctl .mj-panel{display:none;padding:6px 10px 8px;width:210px;font-size:13px;max-height:60vh;overflow:auto}
.myjobs-ctl.open .mj-panel{display:block}
.myjobs-ctl .mj-panel label.chk{display:flex;align-items:center;gap:6px;padding:4px 0}
.myjobs-ctl .mj-panel input[type=checkbox]{width:20px;height:20px}
.myjobs-ctl select{width:100%;font-size:14px;padding:4px;margin:2px 0 4px}
.myjobs-ctl .mj-row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.myjobs-ctl .mj-hint{font-size:11px;color:#475569;margin-top:4px}
.myjobs-ctl .mj-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 3px 0 6px}
.myjobs-ctl button.danger{color:#b91c1c}
.mj-pin{width:26px;height:26px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);color:#fff;font-size:13px;line-height:21px;text-align:center}
.mj-pin.destr{border-radius:5px}
.mj-cluster{border-radius:50%;background:rgba(37,99,235,.9);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center}
.mj-tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;background:#dbeafe;color:#1e40af;margin-bottom:4px}
.mj-popup .small{font-size:12px;margin:2px 0}.mj-popup .mj-conf{border-left:4px solid;padding:2px 6px;margin:6px 0 2px;background:#f8fafc}
.mj-popup .mj-why{font-size:12px;color:#334155;margin-bottom:2px}.mj-popup details{font-size:12px;margin:4px 0}.mj-popup details ul{padding-left:16px;margin:2px 0}
.mj-tip{font-size:12px}`;
  document.head.appendChild(st);
  const Ctl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const d = L.DomUtil.create('div', 'leaflet-bar myjobs-ctl');
      d.innerHTML = '<button type="button" class="mj-btn" title="My past jobs (private, this device only)">⛏ My jobs</button><div class="mj-panel"></div>';
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      return d;
    },
  });
  const ctl = new Ctl().addTo(map), cel = ctl.getContainer(), panel = cel.querySelector('.mj-panel');
  let open = false;
  cel.querySelector('.mj-btn').onclick = () => { open = !open; renderCtl(); };
  function renderCtl() {
    cel.classList.toggle('open', open); cel.classList.toggle('on', !!data && map.hasLayer(group));
    if (!open) return;
    const c = counts();
    const years = data ? [...new Set(data.jobs.filter((j) => !j.dupOf && !j.empty).map((j) => String(j.year || j.group)))].sort() : [];
    const legend = data && data.hasMatches ? `<div class="mj-hint mj-legend">${Object.values(CONF).map(([col, l]) => `<i style="background:${col}"></i>${l}`).join('')}</div>` : '';
    panel.innerHTML = data ? `<label class="chk"><input type="checkbox" class="mj-on" ${map.hasLayer(group) ? 'checked' : ''}> Show <b class="mj-count">${c.jobs}</b>&nbsp;jobs</label>
        <select class="mj-year"><option value="">All years</option>${years.map((y) => `<option ${pref.year === y ? 'selected' : ''}>${esc(y)}</option>`).join('')}</select>
        ${legend}
        <div class="mj-hint">${esc(data.source)} · ${c.lines} drawings${c.dup ? ` · ${c.dup} duplicate folder${c.dup > 1 ? 's' : ''} merged` : ''}${c.empty ? ` · ${c.empty} empty` : ''}${data.hasMatches ? ' · permits matched' : ''}.
          Drawings show from zoom ${DRAW_MIN_ZOOM}; nearby jobs group when zoomed out.</div>
        <div class="mj-row"><button type="button" class="small mj-fit">Zoom to all</button><label class="small btnlike">⬆ Import<input type="file" class="mj-file" accept=".kmz,.kml,.json,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,application/json" hidden></label></div>
        <div class="mj-row"><button type="button" class="small danger mj-del">🗑 Remove my jobs from this device</button></div>
        <div class="mj-hint">🔒 Private: stored only on this device, never uploaded.</div>`
      : `<div>Show your past jobs from Google Earth.</div>
        <div class="mj-row"><label class="small btnlike">⬆ Import .kmz / .kml / .json<input type="file" class="mj-file" accept=".kmz,.kml,.json,application/vnd.google-earth.kmz,application/vnd.google-earth.kml+xml,application/json" hidden></label></div>
        <div class="mj-hint">🔒 The file is read on this device and stored only here — nothing is uploaded.</div>`;
    const f = panel.querySelector('.mj-file');
    f.onchange = async () => {
      const file = f.files && f.files[0]; if (!file) return;
      const hint = document.createElement('div'); hint.className = 'mj-hint mj-status'; hint.textContent = 'Reading ' + file.name + '…'; panel.appendChild(hint);
      try { const n = await importFile(file); toast(`My jobs: ${n.jobs} jobs imported (${n.lines} drawings)`); open = false; }
      catch (e) { console.warn(e); hint.textContent = 'Import failed: ' + (e.message || e); hint.style.color = '#b91c1c'; return; }
      renderCtl();
    };
    if (!data) return;
    panel.querySelector('.mj-on').onchange = (e) => { if (e.target.checked) group.addTo(map); else map.removeLayer(group); };
    panel.querySelector('.mj-year').onchange = (e) => { pref.year = e.target.value; savePref(); render(); fitAll(); };
    panel.querySelector('.mj-fit').onclick = fitAll;
    panel.querySelector('.mj-del').onclick = async () => {
      if (!confirm('Remove all your jobs from this device?\nThe Google Earth file on your computer is not touched.')) return;
      try { await removeAll(); toast('My jobs removed from this device'); } catch (e) { toast('Could not remove: ' + (e.message || e)); }
    };
  }

  // ------------------------------------------------------------------ startup
  Store.get().then((rec) => {
    if (rec && Array.isArray(rec.jobs)) { data = rec; if (pref.on !== false) group.addTo(map); }
    render();
  }).catch(() => renderCtl());
  global.WellsMyJobs = { parseKml, unzipKml, importFile, removeAll, Store, get data() { return data; }, counts, visibleJobs, group, render, zoomJob, fitAll, deriveWell };
})(typeof window !== 'undefined' ? window : globalThis);
