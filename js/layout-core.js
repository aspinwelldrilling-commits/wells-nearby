/* Wells Nearby — septic layout drawing: geometry, legend and file helpers with no DOM or network (also loaded by node for
 * unit checks: tools/test-layout-core.mjs). Needs js/septic-core.js (projector, distances, setback rings).
 * A layout = one plot-plan drawing for a job: {id, name, apn, address, legend:[...], shapes:[...], opts, meta}.
 * Shapes are {id, kind, pts:[[lat, lon], ...], legendId?, label?, closed?, text?, size?, color?}. */
(function (global) {
  'use strict';
  const K = () => global.SepticCore;
  const FT_PER_M = 3.28084;

  // 12 print-friendly colours that also read on satellite imagery
  const PALETTE = [
    { c: '#000000', n: 'black' }, { c: '#ffffff', n: 'white' }, { c: '#dc2626', n: 'red' }, { c: '#f97316', n: 'orange' },
    { c: '#facc15', n: 'yellow' }, { c: '#16a34a', n: 'green' }, { c: '#06b6d4', n: 'cyan' }, { c: '#2563eb', n: 'blue' },
    { c: '#7c3aed', n: 'purple' }, { c: '#ec4899', n: 'pink' }, { c: '#92400e', n: 'brown' }, { c: '#6b7280', n: 'gray' },
  ];
  const WIDTHS = [2, 3, 5, 8];
  const colorName = (c) => (PALETTE.find((p) => p.c === String(c).toLowerCase()) || { n: String(c) }).n;

  // What can be drawn. geom: point | line | poly | text | dim. setbackFt = required distance from any well / proposed well.
  const KINDS = {
    well:    { label: 'Existing well',    geom: 'point', code: 'W',  icon: '💧', legend: 'well', source: true },
    pwell:   { label: 'Proposed well',    geom: 'point', code: 'PW', icon: '⊕', legend: 'pwell', source: true },
    tank:    { label: 'Septic tank',      geom: 'point', code: 'ST', icon: '🟧', legend: 'tank', setbackFt: 100 },
    dbox:    { label: 'Distribution box', geom: 'point', code: 'DB', icon: '▪️', legend: 'dbox', setbackFt: 100 },
    pit:     { label: 'Seepage pit',      geom: 'point', code: 'SP', icon: '🔴', legend: 'pit', setbackFt: 150 },
    leach:   { label: 'Leach line',       geom: 'line',  icon: '〰️', legend: 'leach', setbackFt: 100 },
    sewer:   { label: 'Sewer line',       geom: 'line',  icon: '🟣', legend: 'sewer', setbackFt: 50 },
    tight:   { label: 'Tight line',       geom: 'line',  icon: '┅', legend: 'tight', setbackFt: 50 },
    prop:    { label: 'Property line',    geom: 'line',  icon: '▦', legend: 'prop', segLengths: true },
    line:    { label: 'Other line',       geom: 'line',  icon: '╱', legend: 'line' },
    house:   { label: 'House / building', geom: 'poly',  icon: '🏠', legend: 'house', rect: true },
    field:   { label: 'Leach field',      geom: 'poly',  icon: '▤', legend: 'field', rect: true, setbackFt: 100 },
    reserve: { label: 'Reserve area',     geom: 'poly',  icon: '⬚', legend: 'reserve', rect: true, setbackFt: 100 },
    drive:   { label: 'Driveway',         geom: 'poly',  icon: '🛣️', legend: 'drive' },
    area:    { label: 'Other area',       geom: 'poly',  icon: '⬠', legend: 'area' },
    text:    { label: 'Text label',       geom: 'text',  icon: '🔤' },
    dim:     { label: 'Measure',          geom: 'dim',   icon: '📏' },
  };
  const SYM = { point: 'point', line: 'line', poly: 'area' };
  const symOf = (kind) => SYM[(KINDS[kind] || {}).geom] || null;

  const DEFAULT_LEGEND = [
    { id: 'prop',    label: 'Property line',    color: '#facc15', dash: 'solid',  width: 3, sym: 'line' },
    { id: 'well',    label: 'Existing well',    color: '#2563eb', dash: 'solid',  width: 3, sym: 'point' },
    { id: 'pwell',   label: 'Proposed well',    color: '#06b6d4', dash: 'solid',  width: 3, sym: 'point' },
    { id: 'tank',    label: 'Septic tank',      color: '#f97316', dash: 'solid',  width: 3, sym: 'point' },
    { id: 'dbox',    label: 'Distribution box', color: '#92400e', dash: 'solid',  width: 3, sym: 'point' },
    { id: 'pit',     label: 'Seepage pit',      color: '#dc2626', dash: 'solid',  width: 3, sym: 'point' },
    { id: 'leach',   label: 'Leach lines',      color: '#16a34a', dash: 'solid',  width: 5, sym: 'line' },
    { id: 'sewer',   label: 'Sewer line',       color: '#7c3aed', dash: 'solid',  width: 3, sym: 'line' },
    { id: 'tight',   label: 'Tight line',       color: '#7c3aed', dash: 'dashed', width: 3, sym: 'line' },
    { id: 'line',    label: 'Other line',       color: '#ffffff', dash: 'solid',  width: 2, sym: 'line' },
    { id: 'house',   label: 'House / building', color: '#ffffff', dash: 'solid',  width: 3, sym: 'area' },
    { id: 'field',   label: 'Leach field',      color: '#16a34a', dash: 'dashed', width: 3, sym: 'area' },
    { id: 'reserve', label: 'Reserve area',     color: '#ec4899', dash: 'dashed', width: 3, sym: 'area' },
    { id: 'drive',   label: 'Driveway',         color: '#6b7280', dash: 'solid',  width: 3, sym: 'area' },
    { id: 'area',    label: 'Other area',       color: '#ffffff', dash: 'dashed', width: 2, sym: 'area' },
  ];
  const DEFAULT_IDS = new Set(DEFAULT_LEGEND.map((e) => e.id));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let seq = 0;
  const newId = (p) => `${p || 'id'}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  /** Today's date on the phone's own clock (not UTC), YYYY-MM-DD. */
  const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function newLayout(o = {}) {
    const now = new Date().toISOString();
    return {
      app: 'wells-nearby', kind: 'septic-layout', v: 1, id: newId('lay'), created: now, updated: now,
      name: o.name || 'Septic layout', apn: o.apn || '', address: o.address || '', siteId: o.siteId || null,
      view: o.view || null, legend: clone(DEFAULT_LEGEND), shapes: [],
      opts: { rings: true, sizes: true, orientation: 'landscape', area: 'fit', warnings: true },
      meta: { preparedBy: 'Aspin Well Drilling', date: localDate(), notes: '' },
    };
  }

  // ---------------------------------------------------------------- legend
  const entryOf = (lay, id) => (lay.legend || []).find((e) => e.id === id) || null;
  /** The legend entry a shape is drawn with (its own, else its kind's default, else a neutral one). */
  function styleOf(lay, s) {
    const k = KINDS[s.kind] || {};
    const e = entryOf(lay, s.legendId) || entryOf(lay, k.legend) || DEFAULT_LEGEND.find((d) => d.id === k.legend);
    return e || { id: '', label: k.label || '', color: s.color || '#ffffff', dash: 'solid', width: 3, sym: symOf(s.kind) || 'line' };
  }
  /** Make sure a kind's default legend entry exists (the user may have deleted it); returns its id. */
  function ensureKindEntry(lay, kind) {
    const k = KINDS[kind]; if (!k || !k.legend) return null;
    if (entryOf(lay, k.legend)) return k.legend;
    const d = DEFAULT_LEGEND.find((x) => x.id === k.legend);
    if (d) lay.legend.push(clone(d));
    return d ? d.id : null;
  }
  /** Give a shape the colour / line style / width asked for: link it to the legend entry with exactly that look (same symbol
   *  type), or make a new entry named after the shape's kind. Auto-made entries that end up unused are dropped. */
  function restyle(lay, s, want) {
    const cur = styleOf(lay, s), sym = symOf(s.kind);
    const st = { color: want.color || cur.color, dash: want.dash || cur.dash, width: +(want.width || cur.width) };
    const same = (e) => e.sym === sym && e.color === st.color && e.dash === st.dash && +e.width === st.width;
    let e = same(cur) && entryOf(lay, cur.id) ? cur : (lay.legend.find((x) => same(x) && x.id === (KINDS[s.kind] || {}).legend) || lay.legend.find(same));
    if (!e) {
      const base = (KINDS[s.kind] || {}).label || 'Item';
      let label = base;
      if (lay.legend.some((x) => x.label === label)) label = `${base} (${colorName(st.color)}${st.dash === 'dashed' ? ', dashed' : ''})`;
      e = { id: newId('lg'), label, ...st, sym, auto: true };
      lay.legend.push(e);
    }
    s.legendId = e.id;
    pruneLegend(lay);
    return e;
  }
  const usage = (lay, id) => lay.shapes.filter((s) => styleOf(lay, s).id === id).length;
  function pruneLegend(lay) { lay.legend = lay.legend.filter((e) => !e.auto || usage(lay, e.id) > 0); }
  /** Legend entries used by the drawing, in legend order (for the on-map legend and the plot plan). */
  function usedLegend(lay) {
    const used = new Set(lay.shapes.map((s) => (symOf(s.kind) ? styleOf(lay, s).id : null)).filter(Boolean));
    return lay.legend.filter((e) => used.has(e.id));
  }

  // ---------------------------------------------------------------- geometry (feet, local flat projection)
  const projFor = (pts) => { const p = pts[0] || [0, 0]; return K().projector(p[0], p[1]); };
  function lengthFt(pts, closed) {
    if (!pts || pts.length < 2) return 0;
    const P = projFor(pts), xy = pts.map((p) => P.fwd(p[0], p[1]));
    let m = 0;
    for (let i = 0; i + 1 < xy.length; i++) m += Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]);
    if (closed && xy.length > 2) m += Math.hypot(xy[0][0] - xy[xy.length - 1][0], xy[0][1] - xy[xy.length - 1][1]);
    return m * FT_PER_M;
  }
  const segFt = (a, b) => lengthFt([a, b]);
  function areaSqFt(pts) {
    if (!pts || pts.length < 3) return 0;
    const P = projFor(pts), xy = pts.map((p) => P.fwd(p[0], p[1]));
    let a = 0;
    for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; a += x1 * y2 - x2 * y1; }
    return Math.abs(a / 2) * FT_PER_M * FT_PER_M;
  }
  function centroid(pts) {
    if (!pts.length) return null;
    if (pts.length < 3) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const P = projFor(pts), xy = pts.map((p) => P.fwd(p[0], p[1]));
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length], k = x1 * y2 - x2 * y1; a += k; cx += (x1 + x2) * k; cy += (y1 + y2) * k; }
    if (Math.abs(a) < 1e-9) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    return P.inv(cx / (3 * a), cy / (3 * a));
  }
  /** The point half-way along a polyline (by length). */
  function midAlong(pts) {
    if (pts.length < 2) return pts[0] || null;
    const P = projFor(pts), xy = pts.map((p) => P.fwd(p[0], p[1]));
    const seg = []; let tot = 0;
    for (let i = 0; i + 1 < xy.length; i++) { const d = Math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]); seg.push(d); tot += d; }
    let h = tot / 2;
    for (let i = 0; i < seg.length; i++) {
      if (h <= seg[i] || i === seg.length - 1) { const t = seg[i] ? Math.min(1, h / seg[i]) : 0; return P.inv(xy[i][0] + t * (xy[i + 1][0] - xy[i][0]), xy[i][1] + t * (xy[i + 1][1] - xy[i][1])); }
      h -= seg[i];
    }
    return pts[0];
  }
  function pointInRing(ring, p) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  /** Distance in feet from a well point {lat, lon} to a shape (0 when a well is inside an area) + the nearest point. */
  function distToShape(well, s) {
    const g = (KINDS[s.kind] || {}).geom;
    if (!s.pts || !s.pts.length) return null;
    if (g === 'point' || s.pts.length === 1) return { ft: K().pointDistFt(well, s.pts[0]), nearest: s.pts[0] };
    if (g === 'poly') {
      if (s.pts.length >= 3 && pointInRing(s.pts, [well.lat, well.lon])) return { ft: 0, nearest: [well.lat, well.lon] };
      const r = K().lineDist(well, s.pts.concat([s.pts[0]]));
      return { ft: r.ft, nearest: r.nearest };
    }
    const r = K().lineDist(well, s.closed ? s.pts.concat([s.pts[0]]) : s.pts);
    return { ft: r.ft, nearest: r.nearest };
  }
  /** Rectangle from 3 taps: a-b is one side, c sets how deep it is (perpendicular to a-b). */
  function rectFrom3(a, b, c) {
    const P = K().projector(a[0], a[1]);
    const A = P.fwd(a[0], a[1]), B = P.fwd(b[0], b[1]), Cc = P.fwd(c[0], c[1]);
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L, ny = dx / L, h = (Cc[0] - A[0]) * nx + (Cc[1] - A[1]) * ny;
    const r = (x, y) => P.inv(x, y).map((v) => +v.toFixed(7));
    return [r(A[0], A[1]), r(B[0], B[1]), r(B[0] + nx * h, B[1] + ny * h), r(A[0] + nx * h, A[1] + ny * h)];
  }
  /** Douglas-Peucker in metres (parcel outlines can have hundreds of points along a curved road). */
  function simplify(pts, tolM = 0.3) {
    if (pts.length <= 3) return pts.slice();
    const P = projFor(pts), xy = pts.map((p) => P.fwd(p[0], p[1])), keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop(); let best = -1, bd = 0;
      const [ax, ay] = xy[i], [bx, by] = xy[j], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      for (let k = i + 1; k < j; k++) {
        const t = L2 ? Math.max(0, Math.min(1, ((xy[k][0] - ax) * dx + (xy[k][1] - ay) * dy) / L2)) : 0;
        const d = Math.hypot(xy[k][0] - ax - t * dx, xy[k][1] - ay - t * dy);
        if (d > bd) { bd = d; best = k; }
      }
      if (best > 0 && bd > tolM) { keep[best] = 1; stack.push([i, best], [best, j]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  /** Parcel rings ([[lat, lon], ...], first == last) -> property-line shapes (closed, simplified, editable). */
  function parcelShapes(rings, apn) {
    return (rings || []).filter((r) => r && r.length >= 3).map((r) => {
      let pts = r.map((p) => [+(+p[0]).toFixed(7), +(+p[1]).toFixed(7)]);
      if (pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
      pts = simplify(pts.concat([pts[0]]), 0.15).slice(0, -1);
      return { id: newId('sh'), kind: 'prop', pts, closed: true, legendId: 'prop', src: 'parcel', label: '', apn: apn || '' };
    });
  }

  // ---------------------------------------------------------------- setbacks
  const wellsOf = (lay) => lay.shapes.filter((s) => (KINDS[s.kind] || {}).source && s.pts && s.pts.length).map((s) => ({ shape: s, lat: s.pts[0][0], lon: s.pts[0][1] }));
  /** Every septic item vs every well: the worst (closest relative to its setback) per item. */
  function setbackChecks(lay) {
    const wells = wellsOf(lay), rows = [];
    for (const s of lay.shapes) {
      const k = KINDS[s.kind]; if (!k || !k.setbackFt || !s.pts || !s.pts.length) continue;
      let worst = null;
      for (const w of wells) {
        const d = distToShape(w, s); if (!d) continue;
        if (!worst || d.ft < worst.ft) worst = { shape: s, well: w.shape, wellPt: [w.lat, w.lon], ft: d.ft, nearest: d.nearest, limitFt: k.setbackFt };
      }
      if (worst) {
        worst.status = worst.ft < worst.limitFt ? 'inside' : worst.ft < worst.limitFt + K().NEAR_FT ? 'near' : 'ok';
        worst.ftRounded = Math.round(worst.ft); worst.shortFt = Math.max(0, Math.round(worst.limitFt - worst.ft));
        rows.push(worst);
      } else rows.push({ shape: s, well: null, status: 'nowell', limitFt: k.setbackFt });
    }
    return { rows, wells, inside: rows.filter((r) => r.status === 'inside'), near: rows.filter((r) => r.status === 'near') };
  }
  const itemName = (s) => (s.label ? `${KINDS[s.kind].label} “${s.label}”` : KINDS[s.kind].label);
  function checkText(r) {
    if (r.status === 'nowell') return `${itemName(r.shape)} — add a well or proposed well to check the ${r.limitFt} ft setback`;
    const wn = r.well ? (KINDS[r.well.kind].label.toLowerCase() + (r.well.label ? ` “${r.well.label}”` : '')) : 'well';
    if (r.status === 'inside') return `⚠ ${itemName(r.shape)} is ${r.ftRounded} ft from the ${wn} — inside the ${r.limitFt} ft setback (${r.shortFt} ft short)`;
    if (r.status === 'near') return `${itemName(r.shape)} is ${r.ftRounded} ft from the ${wn} — just outside ${r.limitFt} ft; check with a tape`;
    return `✓ ${itemName(r.shape)} is ${r.ftRounded} ft from the ${wn} (needs ${r.limitFt} ft)`;
  }

  // ---------------------------------------------------------------- bounds, scale bar, formatting
  function boundsOf(lay, withRings) {
    let s = 90, w = 180, n = -90, e = -180, any = false;
    const add = (p) => { any = true; s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); };
    for (const sh of lay.shapes) for (const p of sh.pts || []) add(p);
    if (withRings) for (const wl of wellsOf(lay)) for (const r of K().RINGS) for (const p of K().circle(wl, r.ft, 24)) add(p);
    return any ? [[s, w], [n, e]] : null;
  }
  /** A round scale-bar length (feet) about targetPx long, given feet per pixel. */
  function niceScale(ftPerPx, targetPx) {
    const want = ftPerPx * targetPx, steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
    let ft = steps[0];
    for (const v of steps) if (v <= want) ft = v;
    return { ft, px: ft / ftPerPx };
  }
  const fmtFt = (ft) => (ft >= 100 ? Math.round(ft).toLocaleString('en-US') : (Math.round(ft * 10) / 10).toLocaleString('en-US')) + ' ft';
  const fmtSqFt = (a) => Math.round(a).toLocaleString('en-US') + ' sq ft' + (a >= 21780 ? ` (${(a / 43560).toFixed(2)} ac)` : '');
  /** Short text of a shape's size for labels: line length / area / distance. */
  function sizeText(s) {
    const g = (KINDS[s.kind] || {}).geom;
    if (g === 'line') return fmtFt(lengthFt(s.pts, s.closed));
    if (g === 'dim') return fmtFt(lengthFt(s.pts));
    if (g === 'poly') return fmtSqFt(areaSqFt(s.pts));
    return '';
  }

  // ---------------------------------------------------------------- import / validation
  const okPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) && Math.abs(+p[0]) <= 90 && Math.abs(+p[1]) <= 180;
  const str = (v, max = 400) => String(v == null ? '' : v).slice(0, max);
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  /** Clean up a layout read from a file (or an older version): returns a valid layout or throws. */
  function normalize(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.shapes)) throw new Error('not a septic layout file');
    const base = newLayout();
    const lay = { ...base, id: str(o.id, 80) || base.id, name: str(o.name, 120) || 'Imported layout', apn: str(o.apn, 40), address: str(o.address, 200),
      siteId: o.siteId ? str(o.siteId, 80) : null, created: str(o.created, 40) || base.created, updated: str(o.updated, 40) || base.updated,
      view: o.view && Number.isFinite(+o.view.lat) && Number.isFinite(+o.view.lon) ? { lat: +o.view.lat, lon: +o.view.lon, z: Math.max(1, Math.min(21, +o.view.z || 18)) } : null };
    lay.opts = { ...base.opts, ...(o.opts && typeof o.opts === 'object' ? o.opts : {}) };
    lay.opts.orientation = lay.opts.orientation === 'portrait' ? 'portrait' : 'landscape';
    lay.opts.area = lay.opts.area === 'view' ? 'view' : 'fit';
    lay.meta = { ...base.meta, ...(o.meta && typeof o.meta === 'object' ? { preparedBy: str(o.meta.preparedBy, 120), date: str(o.meta.date, 40), notes: str(o.meta.notes, 2000) } : {}) };
    if (Array.isArray(o.legend) && o.legend.length) {
      lay.legend = o.legend.filter((e) => e && e.id && ['point', 'line', 'area'].includes(e.sym)).map((e) => ({ id: str(e.id, 80), label: str(e.label, 80),
        color: COLOR_RE.test(e.color) ? e.color.toLowerCase() : '#ffffff', dash: e.dash === 'dashed' ? 'dashed' : 'solid', width: Math.max(1, Math.min(12, +e.width || 3)), sym: e.sym, ...(e.auto ? { auto: true } : {}) }));
    }
    lay.shapes = o.shapes.filter((s) => s && KINDS[s.kind] && Array.isArray(s.pts) && s.pts.length && s.pts.every(okPt)).map((s) => {
      const g = KINDS[s.kind].geom;
      const need = { point: 1, text: 1, dim: 2, line: 2, poly: 3 }[g];
      const pts = s.pts.map((p) => [+(+p[0]).toFixed(7), +(+p[1]).toFixed(7)]);
      if (pts.length < need) return null;
      const out = { id: str(s.id, 80) || newId('sh'), kind: s.kind, pts: g === 'point' || g === 'text' ? pts.slice(0, 1) : g === 'dim' ? pts.slice(0, 2) : pts };
      if (s.legendId) out.legendId = str(s.legendId, 80);
      if (s.label) out.label = str(s.label, 120);
      if (s.closed && g === 'line') out.closed = true;
      if (s.src) out.src = str(s.src, 20);
      if (g === 'text') { out.text = str(s.text, 200) || 'Text'; out.size = ['s', 'm', 'l'].includes(s.size) ? s.size : 'm'; out.color = COLOR_RE.test(s.color) ? s.color.toLowerCase() : '#ffffff'; }
      return out;
    }).filter(Boolean);
    return lay;
  }
  const exportJson = (lay) => JSON.stringify({ app: 'wells-nearby', kind: 'septic-layout', version: 1, exported: new Date().toISOString(), layout: lay }, null, 1);
  /** Parse a backup file: one layout, {layout}, {layouts:[...]} or an array. */
  function parseFile(text) {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : Array.isArray(j.layouts) ? j.layouts : j.layout ? [j.layout] : [j];
    const out = list.map(normalize);
    if (!out.length) throw new Error('no layouts in the file');
    return out;
  }

  // ---------------------------------------------------------------- minimal PDF: one page, one JPEG filling it
  /** jpeg: Uint8Array (baseline JPEG), wPx/hPx its size, page in points (letter = 612 x 792). */
  function pdfFromJpeg(jpeg, wPx, hPx, pageW, pageH, title) {
    const enc = new TextEncoder(), parts = [], offs = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, f) => { offs[n] = len; push(`${n} 0 obj\n`); f(); push('\nendobj\n'); };
    const pdfStr = (s) => '(' + String(s || '').replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1') + ')';
    push('%PDF-1.4\n'); push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>`));
    obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`); push(jpeg); push('\nendstream'); });
    const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
    obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(6, () => push(`<< /Title ${pdfStr(title)} /Producer (Wells Nearby septic layout) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`));
    const xref = len;
    push(`xref\n0 7\n0000000000 65535 f \n${offs.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let o = 0;
    for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }

  global.LayoutCore = { localDate, FT_PER_M, PALETTE, WIDTHS, KINDS, DEFAULT_LEGEND, DEFAULT_IDS, symOf, colorName, newId, newLayout, entryOf, styleOf, ensureKindEntry, restyle,
    usage, pruneLegend, usedLegend, lengthFt, segFt, areaSqFt, centroid, midAlong, pointInRing, distToShape, rectFrom3, simplify, parcelShapes,
    wellsOf, setbackChecks, checkText, itemName, boundsOf, niceScale, fmtFt, fmtSqFt, sizeText, normalize, exportJson, parseFile, pdfFromJpeg };
})(typeof window !== 'undefined' ? window : globalThis);
