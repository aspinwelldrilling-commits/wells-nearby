/* Wells Nearby — septic/sewer helpers with no DOM or network (also loaded by node for unit checks: tools/test-septic-core.mjs).
 * Setback distances, parcel sewer/septic designations in plain words, DEH document merging, APN/address helpers. */
(function (global) {
  'use strict';
  const FT_PER_M = 3.28084;

  // Travis's setbacks from a water well (feet). Marks are compared with the setback of their own kind.
  const KINDS = {
    tank:  { label: 'Septic tank',  geom: 'point', setbackFt: 100, color: '#f97316', icon: '🟠' },
    leach: { label: 'Leach line',   geom: 'line',  setbackFt: 100, color: '#f97316', icon: '〰️' },
    pit:   { label: 'Seepage pit',  geom: 'point', setbackFt: 150, color: '#ef4444', icon: '🔴' },
    sewer: { label: 'Sewer line',   geom: 'line',  setbackFt: 50,  color: '#a855f7', icon: '🟣' },
    tight: { label: 'Tight line',   geom: 'line',  setbackFt: 50,  color: '#a855f7', icon: '🟪' },
  };
  const RINGS = [
    { ft: 50,  color: '#a855f7', label: '50 ft · sewer / tight line' },
    { ft: 100, color: '#f97316', label: '100 ft · tank / leach line' },
    { ft: 150, color: '#ef4444', label: '150 ft · seepage pit' },
  ];
  const NEAR_FT = 10;  // within this many feet OUTSIDE the setback -> "close, check with a tape"

  // Local flat projection around the well site (meters east/north). Exact enough for the few hundred feet that matter
  // here (error < 0.01 %); the WGS84 radii make east-west and north-south scales correct at this latitude.
  function projector(lat0, lon0) {
    const a = 6378137, e2 = 0.00669437999014, s = Math.sin(lat0 * Math.PI / 180);
    const w = Math.sqrt(1 - e2 * s * s);
    const mPerDegLat = (Math.PI / 180) * a * (1 - e2) / (w * w * w);
    const mPerDegLon = (Math.PI / 180) * a * Math.cos(lat0 * Math.PI / 180) / w;
    return {
      fwd: (lat, lon) => [(lon - lon0) * mPerDegLon, (lat - lat0) * mPerDegLat],
      inv: (x, y) => [lat0 + y / mPerDegLat, lon0 + x / mPerDegLon],
    };
  }
  // Distance in feet from the site to a point [lat, lon]
  function pointDistFt(site, p) {
    const P = projector(site.lat, site.lon), [x, y] = P.fwd(p[0], p[1]);
    return Math.hypot(x, y) * FT_PER_M;
  }
  // Distance in feet from the site to a polyline [[lat, lon], ...] (nearest point on any segment) + that nearest point
  function lineDist(site, pts) {
    const P = projector(site.lat, site.lon);
    const xy = pts.map((p) => P.fwd(p[0], p[1]));
    let best = { m: Infinity, x: 0, y: 0, seg: -1 };
    if (xy.length === 1) best = { m: Math.hypot(xy[0][0], xy[0][1]), x: xy[0][0], y: xy[0][1], seg: 0 };
    for (let i = 0; i + 1 < xy.length; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));   // project the origin (site) onto AB
      const x = ax + t * dx, y = ay + t * dy, m = Math.hypot(x, y);
      if (m < best.m) best = { m, x, y, seg: i };
    }
    return { ft: best.m * FT_PER_M, nearest: best.seg < 0 ? null : P.inv(best.x, best.y), seg: best.seg };
  }
  // Evaluate one mark {kind, pts:[[lat,lon],...]} against the site {lat, lon}
  function evaluate(site, mark) {
    const k = KINDS[mark.kind];
    if (!k || !mark.pts || !mark.pts.length) return null;
    const r = k.geom === 'point' ? { ft: pointDistFt(site, mark.pts[0]), nearest: mark.pts[0] } : lineDist(site, mark.pts);
    const ft = r.ft, limit = k.setbackFt;
    const status = ft < limit ? 'inside' : ft < limit + NEAR_FT ? 'near' : 'ok';
    return { kind: mark.kind, label: k.label, ft, ftRounded: Math.round(ft), limitFt: limit, status, shortFt: Math.max(0, Math.round(limit - ft)), nearest: r.nearest };
  }
  function evaluateAll(site, marks) {
    const rows = (marks || []).map((m) => ({ mark: m, r: evaluate(site, m) })).filter((x) => x.r);
    return { rows, inside: rows.filter((x) => x.r.status === 'inside'), near: rows.filter((x) => x.r.status === 'near') };
  }
  function warningText(r) {
    if (r.status === 'inside') return `⚠ ${r.label} is ${r.ftRounded} ft from the well — inside the ${r.limitFt} ft setback (${r.shortFt} ft short)`;
    if (r.status === 'near') return `${r.label} is ${r.ftRounded} ft from the well — just outside the ${r.limitFt} ft setback; check with a tape`;
    return `✓ ${r.label} is ${r.ftRounded} ft from the well (needs ${r.limitFt} ft)`;
  }
  // Circle around the site as [[lat,lon],...] (for KML export)
  function circle(site, ft, n = 72) {
    const P = projector(site.lat, site.lon), m = ft / FT_PER_M, out = [];
    for (let i = 0; i <= n; i++) { const a = (2 * Math.PI * i) / n; out.push(P.inv(m * Math.sin(a), m * Math.cos(a))); }
    return out;
  }

  // ---------- parcel sewer/septic designation (WW_Septic_Sewer_Public) in plain words ----------
  const DESIGNATION = [
    { re: /^known sewer/i,               key: 'sewer',   short: 'On sewer (confirmed)',   text: 'On sewer — confirmed by the sewer agency or County records.' },
    { re: /^known septic/i,              key: 'septic',  short: 'Septic (confirmed)',     text: 'On septic — confirmed by County septic records, the sewer agency, or the septic rebate program.' },
    { re: /^likely septic/i,             key: 'septic?', short: 'Probably septic',        text: 'Probably septic — the County has septic-related records for this parcel.' },
    { re: /assumed sewer.*infrastructure/i, key: 'sewer?', short: 'Probably sewer',      text: 'Probably sewer — a mapped sewer main, manhole, or lateral is next to the parcel (within ~175 ft).' },
    { re: /assumed sewer.*boundary/i,    key: 'sewer?',  short: 'Maybe sewer',            text: 'Maybe sewer — the parcel is inside a sewer district boundary, but no pipe data was available.' },
    { re: /^assumed septic/i,            key: 'septic?', short: 'Maybe septic',           text: 'Maybe septic — there is a building (or bathroom) but no sewer record.' },
  ];
  function designation(attrs) {
    if (!attrs) return { key: 'none', short: 'Not in the layer', text: 'This parcel is not in the County sewer/septic layer.', level: null, raw: '' };
    const raw = attrs.sewer_septic_parcel_designation || attrs.Sewer_Septic_Parcel_Designation || '';
    const lvl = attrs.septic_sewer_designation_confid ?? attrs.Septic_Sewer_Designation_Confid ?? null;
    const d = DESIGNATION.find((x) => x.re.test(raw));
    return d ? { key: d.key, short: d.short, text: d.text, level: lvl, raw } : { key: 'unknown', short: 'Unknown', text: 'Not known — the County has no sewer or septic information for this parcel.', level: lvl, raw };
  }
  const levelText = (lvl) => (lvl == null ? 'no confidence level' : `confidence level ${lvl} of 6 (1 = most certain)`);
  const SCREENING_NOTE = 'Screening layer (County DPW/DEHQ, data through May 2025) — a guide, not proof. Check the records and the site.';

  // ---------- APN / address helpers ----------
  const apnDigits = (a) => String(a || '').replace(/\D/g, '');
  function apnDashed(a) { const d = apnDigits(a); return d.length >= 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}` : d.length === 8 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}` : ''; }
  // The DEH library matches APNs as "contains": "284-291-60" also finds "284-291-60-00" and multi-APN archive files.
  function apnSearchKey(a) { const d = apnDigits(a); return d.length >= 8 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}` : ''; }
  function apnPage(a) { const d = apnDigits(a); return d.length >= 6 ? `${d.slice(0, 3)}-${d.slice(3, 6)}` : ''; }
  const STREET_TYPES = new Set('RD ROAD ST STREET AVE AV AVENUE DR DRIVE LN LANE CT COURT WAY PL PLACE BLVD CIR CIRCLE TER TERRACE TRL TRAIL HWY PKWY LOOP RUN PT PATH ROW GLN GLEN CV XING SQ'.split(' '));
  // {num, name} for the DEH address search (street number + street name without the type), or null
  function addressParts(parcel, address) {
    if (parcel && parcel.situsNum && parcel.situsStreet) return { num: String(parcel.situsNum), name: String(parcel.situsStreet).trim().toUpperCase() };
    const first = String(address || '').split(',')[0].trim().toUpperCase();
    const m = first.match(/^(\d+)\s+(?:1\/2\s+)?(.+)$/);
    if (!m) return null;
    const words = m[2].split(/\s+/).filter((w) => !/^#/.test(w));
    while (words.length > 1 && STREET_TYPES.has(words[words.length - 1])) words.pop();
    if (words.length > 1 && /^[NSEW]$/.test(words[0])) words.shift();
    return words.length ? { num: m[1], name: words.join(' ') } : null;
  }

  // ---------- DEH document library records ----------
  const SEPTIC_SUBTYPES = ['DEH-LWQD-OWTS Layout', 'DEH-LWQD-OWTS Permit', 'DEH-LWQD-Land Use Archive-Parcel'];
  const SUBTYPE_INFO = {
    'OWTS Layout': { order: 1, icon: '📐', label: 'Septic layout (plot plan)' },
    'OWTS Permit': { order: 2, icon: '📄', label: 'Septic permit' },
    'Land Use Archive-Parcel': { order: 3, icon: '🗄️', label: 'Old septic file (archive)' },
  };
  const fileIdOf = (url) => { const m = String(url || '').match(/FileRecordId=(\d+)/i); return m ? m[1] : String(url || ''); };
  function normDoc(d) {
    const sub = String(d.lueg_subtype || '').replace(/^DEH-LWQD-/, '');
    return { fileId: fileIdOf(d.url), url: d.url, permit: d.permit_id || '', apn: d.parcel_nbr || '', subtype: sub,
      info: SUBTYPE_INFO[sub] || { order: 9, icon: '📄', label: sub || 'Document' },
      description: d.description || '', scanned: String(d.r_creation_date || '').slice(0, 10), sizeKb: Math.round((+d.r_content_size || 0) / 1024) };
  }
  // Merge result lists [{via, docs}] -> unique by FileRecordId, remembering how each was found
  function mergeDocs(lists) {
    const by = new Map();
    for (const { via, docs } of lists) for (const d of docs || []) {
      const cur = by.get(d.fileId);
      if (cur) { if (!cur.via.includes(via)) cur.via.push(via); if (!cur.apn && d.apn) cur.apn = d.apn; }
      else by.set(d.fileId, { ...d, via: [via] });
    }
    return [...by.values()].sort((a, b) => a.info.order - b.info.order || (a.scanned < b.scanned ? 1 : a.scanned > b.scanned ? -1 : 0));
  }
  // Neighbor docs from a book-page search, excluding the parcel's own, grouped by parcel string
  function groupNeighbors(docs, ownKey) {
    const groups = new Map();
    for (const d of docs) {
      if (ownKey && d.apn.includes(ownKey)) continue;
      const k = d.apn || '(no APN)';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([apn, list]) => ({ apn, docs: mergeDocs([{ via: 'page', docs: list }]) }));
  }

  global.SepticCore = { FT_PER_M, KINDS, RINGS, NEAR_FT, projector, pointDistFt, lineDist, evaluate, evaluateAll, warningText, circle,
    designation, levelText, SCREENING_NOTE, apnDigits, apnDashed, apnSearchKey, apnPage, addressParts,
    SEPTIC_SUBTYPES, SUBTYPE_INFO, fileIdOf, normDoc, mergeDocs, groupNeighbors };
})(typeof window !== 'undefined' ? window : globalThis);
