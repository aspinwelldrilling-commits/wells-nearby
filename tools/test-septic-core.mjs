// Unit-style checks for js/septic-core.js (setback distances + warnings, designations, APN/address, doc merging).
// Usage: node tools/test-septic-core.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../js/septic-core.js');
const S = globalThis.SepticCore;
let fails = 0, n = 0;
const check = (ok, msg) => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// independent reference: Vincenty-grade accuracy is not needed; haversine on the WGS84 mean radius is within ~0.3 %
const R = 6371008.8, rad = Math.PI / 180;
const hav = (a, b) => { const dl = (b[0] - a[0]) * rad, dn = (b[1] - a[1]) * rad; const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) * 3.28084; };
const site = { lat: 33.0375787, lon: -116.8452545 };  // 309 Calle Amistad, Ramona
const P = S.projector(site.lat, site.lon);
const at = (eastFt, northFt) => P.inv(eastFt / 3.28084, northFt / 3.28084);   // [lat, lon] at an offset in feet

// --- projection round trip and agreement with haversine
for (const [e, nn] of [[100, 0], [0, 100], [70.71, 70.71], [-150, 20], [0, -49.9], [400, -300]]) {
  const p = at(e, nn), want = Math.hypot(e, nn);
  check(near(S.pointDistFt(site, p), want, 0.01), `point at (${e}, ${nn}) ft -> ${S.pointDistFt(site, p).toFixed(3)} ft (want ${want.toFixed(2)})`);
  check(near(hav([site.lat, site.lon], p), want, want * 0.004 + 0.05), `  haversine agrees: ${hav([site.lat, site.lon], p).toFixed(2)} ft`);
}
// 1 arc-second of latitude ≈ 101 ft at 33° N (independent geodesy fact: 110,922 m/deg -> 30.81 m/")
check(near(S.pointDistFt(site, [site.lat + 1 / 3600, site.lon]), 101.08, 0.15), `1" latitude = ${S.pointDistFt(site, [site.lat + 1 / 3600, site.lon]).toFixed(2)} ft (≈101.1)`);

// --- point-to-segment distances
const L = (...pts) => pts.map(([e, nn]) => at(e, nn));
let r = S.lineDist(site, L([-50, 40], [50, 40]));
check(near(r.ft, 40, 0.01), `perpendicular foot inside segment: ${r.ft.toFixed(3)} ft (want 40)`);
check(near(S.pointDistFt(site, r.nearest), 40, 0.01), '  nearest point returned on the segment');
r = S.lineDist(site, L([30, 40], [130, 40]));
check(near(r.ft, 50, 0.01), `foot beyond the end -> nearest endpoint: ${r.ft.toFixed(3)} ft (want 50 = 3-4-5)`);
r = S.lineDist(site, L([-100, -10], [100, 10]));
check(near(r.ft, 0, 0.01), `line passing through the well: ${r.ft.toFixed(3)} ft (want 0)`);
r = S.lineDist(site, L([200, 200], [200, 90], [60, 90], [60, -200]));
check(near(r.ft, 60, 0.01) && r.seg === 2, `multi-segment polyline picks nearest segment: ${r.ft.toFixed(3)} ft on seg ${r.seg} (want 60 on seg 2)`);
r = S.lineDist(site, L([30, 40], [30, 40]));
check(near(r.ft, 50, 0.01), `zero-length segment = point distance: ${r.ft.toFixed(3)}`);
r = S.lineDist(site, L([0, 75]));
check(near(r.ft, 75, 0.01), 'single-vertex line = point distance');
// long diagonal line checked against brute-force sampling with haversine
const a = at(-300, 120), b = at(250, -40);
let brute = Infinity; for (let i = 0; i <= 20000; i++) { const t = i / 20000; brute = Math.min(brute, hav([site.lat, site.lon], [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])); }
r = S.lineDist(site, [a, b]);
check(near(r.ft, brute, 0.3), `diagonal line vs brute-force haversine: ${r.ft.toFixed(2)} vs ${brute.toFixed(2)} ft`);

// --- setback rules and warnings (50 sewer/tight, 100 tank/leach, 150 pit)
check(S.KINDS.sewer.setbackFt === 50 && S.KINDS.tight.setbackFt === 50 && S.KINDS.tank.setbackFt === 100 && S.KINDS.leach.setbackFt === 100 && S.KINDS.pit.setbackFt === 150, 'setbacks: sewer/tight 50, tank/leach 100, pit 150');
const ev = (kind, pts) => S.evaluate(site, { kind, pts });
let e = ev('leach', L([-80, 72], [80, 72]));
check(e.status === 'inside' && e.ftRounded === 72 && e.shortFt === 28, `leach line 72 ft -> inside 100 ft, 28 ft short (${e.status}, ${e.ftRounded})`);
check(/inside the 100 ft setback/.test(S.warningText(e)) && /72 ft/.test(S.warningText(e)), '  warning text: ' + S.warningText(e));
e = ev('leach', L([-80, 105], [80, 105]));
check(e.status === 'near', `leach line 105 ft -> "near" (within ${S.NEAR_FT} ft outside)`);
e = ev('leach', L([-80, 130], [80, 130]));
check(e.status === 'ok' && /✓/.test(S.warningText(e)), 'leach line 130 ft -> ok');
e = ev('tank', [at(0, 99.9)]);   check(e.status === 'inside', 'tank at 99.9 ft -> inside');
e = ev('tank', [at(0, 100.05)]); check(e.status !== 'inside', 'tank at 100.05 ft -> not inside (exactly the limit is compliant)');
e = ev('pit', [at(120, 0)]);     check(e.status === 'inside' && e.limitFt === 150, 'seepage pit 120 ft -> inside 150 ft');
e = ev('pit', [at(120, 0)]);     check(e.shortFt === 30, '  30 ft short');
e = ev('sewer', L([45, -100], [45, 100])); check(e.status === 'inside' && e.ftRounded === 45, 'sewer line 45 ft -> inside 50 ft');
e = ev('tight', L([55, -100], [55, 100])); check(e.status === 'near', 'tight line 55 ft -> near');
e = ev('tank', [at(0, 120)]);    check(e.status === 'ok', 'tank 120 ft -> ok (a pit there would be inside)');
check(ev('pit', [at(0, 120)]).status === 'inside', 'pit at same 120 ft -> inside');
const all = S.evaluateAll(site, [{ kind: 'leach', pts: L([-80, 72], [80, 72]) }, { kind: 'tank', pts: [at(0, 200)] }, { kind: 'bogus', pts: [at(0, 1)] }, { kind: 'pit', pts: [] }]);
check(all.rows.length === 2 && all.inside.length === 1, 'evaluateAll skips invalid marks, counts 1 inside');
const ring = S.circle(site, 100);
check(ring.every((p) => near(S.pointDistFt(site, p), 100, 0.01)) && ring.length === 73, 'circle(100 ft) points all 100 ft away');

// --- designations
check(S.designation({ sewer_septic_parcel_designation: 'Known Septic Connected', septic_sewer_designation_confid: 2 }).short === 'Septic (confirmed)', 'Known Septic -> "Septic (confirmed)"');
check(S.designation({ sewer_septic_parcel_designation: 'Assumed Sewer Connected (per infrastructure)', septic_sewer_designation_confid: 4 }).key === 'sewer?', 'Assumed sewer (infra) -> probably sewer');
check(S.designation({ sewer_septic_parcel_designation: 'Assumed Sewer Connected (per boundary)' }).short === 'Maybe sewer', 'Assumed sewer (boundary) -> maybe sewer');
check(S.designation({ sewer_septic_parcel_designation: 'Not Known' }).key === 'unknown', 'Not Known -> unknown');
check(S.designation(null).key === 'none', 'missing parcel -> none');
check(/level 2 of 6/.test(S.levelText(2)), 'level text');

// --- APN + address
check(S.apnDashed('2842916000') === '284-291-60-00' && S.apnSearchKey('284-291-60-00') === '284-291-60' && S.apnPage('284-291-60-00') === '284-291', 'APN formats (dashed, search key, book-page)');
check(S.apnSearchKey('') === '' && S.apnPage('12') === '', 'bad APN -> empty keys');
const ap = (p, a) => JSON.stringify(S.addressParts(p, a));
check(ap({ situsNum: 1082, situsStreet: 'HERITAGE RANCH' }, '') === '{"num":"1082","name":"HERITAGE RANCH"}', 'address from parcel situs fields');
check(ap(null, '309 Calle Amistad Dr, Ramona 92065') === '{"num":"309","name":"CALLE AMISTAD"}', 'address parsed from text, street type dropped');
check(ap(null, '23832 HIGHWAY 78, RAMONA') === '{"num":"23832","name":"HIGHWAY 78"}', 'numbered highway kept');
check(S.addressParts(null, 'OLD JULIAN HWY') === null && S.addressParts(null, '') === null, 'no house number -> no address search');

// --- document merge / dedupe / neighbors
const raw = (id, sub, apn, date) => S.normDoc({ url: 'https://file.sandiegocounty.gov/LUEG/LUEG_View?FileRecordId=' + id, lueg_subtype: 'DEH-LWQD-' + sub, parcel_nbr: apn, r_creation_date: date, r_content_size: '2048' });
const byApn = [raw(1, 'OWTS Layout', '284-291-60-00', '2015-10-16'), raw(2, 'Land Use Archive-Parcel', '284-291-60-00', '2013-09-21'), raw(3, 'OWTS Layout', '284-291-60-00', '2015-07-14')];
const byAddr = [raw(1, 'OWTS Layout', '', '2015-10-16'), raw(4, 'OWTS Permit', '', '2006-01-01')];
const m = S.mergeDocs([{ via: 'APN', docs: byApn }, { via: 'address', docs: byAddr }]);
check(m.length === 4, `merge de-duplicates by FileRecordId (${m.length} of 5)`);
check(m[0].fileId === '1' && m[0].via.join() === 'APN,address' && m[0].apn === '284-291-60-00', 'doc found both ways keeps both sources and the APN');
check(m.map((d) => d.subtype).join('|') === 'OWTS Layout|OWTS Layout|OWTS Permit|Land Use Archive-Parcel', 'sorted: layouts, permits, archive');
check(m[0].scanned > m[1].scanned, 'newest layout first');
const g = S.groupNeighbors([raw(5, 'OWTS Layout', '284-291-59-00', '2010-01-01'), raw(1, 'OWTS Layout', '284-291-60-00', ''), raw(6, 'OWTS Permit', '284-291-59-00', ''), raw(7, 'Land Use Archive-Parcel', '284-291-61-00 - 284-291-60-00', '')], '284-291-60');
check(g.length === 1 && g[0].apn === '284-291-59-00' && g[0].docs.length === 2, 'neighbors grouped by parcel, own parcel (incl. multi-APN files) excluded');
console.log(`${n - fails}/${n} passed`); process.exit(fails ? 1 : 0);
