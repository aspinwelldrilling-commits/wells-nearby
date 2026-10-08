// Unit-style checks for js/layout-core.js (✏️ Septic layout: geometry in feet, setbacks, legend linking, parcel lines, import, PDF writer).
// Usage: node tools/test-layout-core.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('../js/septic-core.js');
require('../js/layout-core.js');
const S = globalThis.SepticCore, LC = globalThis.LayoutCore;
let fails = 0, n = 0;
const check = (ok, msg) => { n++; if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const O = [32.9952, -116.9226];   // APN 285-030-06-00 area (synthetic drawing)
const P = S.projector(O[0], O[1]);
const at = (e, nn) => P.inv(e / 3.28084, nn / 3.28084).map((v) => +v.toFixed(8));
const sh = (kind, pts, extra = {}) => ({ id: LC.newId('sh'), kind, pts, legendId: (LC.KINDS[kind] || {}).legend, ...extra });

// palette + legend defaults
check(LC.PALETTE.length >= 10 && new Set(LC.PALETTE.map((p) => p.c)).size === LC.PALETTE.length, `${LC.PALETTE.length} distinct colours`);
const L0 = LC.newLayout({ name: 'Test' });
check(L0.legend.length >= 10 && L0.legend.every((e) => e.id && e.label && /^#[0-9a-f]{6}$/.test(e.color)), `default legend has ${L0.legend.length} entries`);
check(L0.meta.preparedBy === 'Aspin Well Drilling' && /^\d{4}-\d{2}-\d{2}$/.test(L0.meta.date), 'title block defaults (prepared by, local date)');
check(L0.legend.find((e) => e.id === 'tight').dash === 'dashed' && L0.legend.find((e) => e.id === 'sewer').dash === 'solid', 'tight line dashed vs sewer line solid by default');

// geometry
check(near(LC.lengthFt([at(0, 0), at(100, 0), at(100, 50)]), 150, 0.05), 'polyline length 100 + 50 ft');
check(near(LC.lengthFt([at(0, 0), at(100, 0), at(100, 50)], true), 150 + Math.hypot(100, 50), 0.1), 'closed loop adds the closing side');
check(near(LC.areaSqFt([at(0, 0), at(40, 0), at(40, 60), at(0, 60)]), 2400, 1), 'rectangle 40 x 60 = 2,400 sq ft');
const r3 = LC.rectFrom3(at(0, 0), at(50, 0), at(10, 30));
check(r3.length === 4 && near(LC.areaSqFt(r3), 1500, 1) && near(LC.segFt(r3[1], r3[2]), 30, 0.05), 'rectangle from 3 taps (50 ft side, 30 ft deep)');
const rr = LC.rectFrom3(at(0, 0), at(30, 30), at(-20, 20));
check(near(LC.areaSqFt(rr), Math.hypot(30, 30) * Math.hypot(20, 20), 2), 'rotated rectangle from 3 taps keeps right angles');
check(LC.fmtFt(63.84) === '63.8 ft' && LC.fmtFt(1234.4) === '1,234 ft' && LC.fmtSqFt(43560).includes('1.00 ac'), 'feet / sq ft / acre formatting');
check(LC.niceScale(1, 120).ft === 100 && LC.niceScale(0.4, 150).ft === 50, 'scale bar picks round lengths');

// setbacks: 50 sewer / tight, 100 tank / leach, 150 pit
const lay = LC.newLayout({ name: 'Test' });
lay.shapes.push(sh('well', [at(0, 0)]));
lay.shapes.push(sh('tank', [at(60, 0)]));                       // 60 < 100 inside
lay.shapes.push(sh('leach', [at(-50, -105), at(50, -105)]));     // 105: near (within 10 ft outside)
lay.shapes.push(sh('pit', [at(0, 170)]));                        // 170 ok (160 would be 'near')
lay.shapes.push(sh('sewer', [at(-45, 20), at(-45, 60)]));        // ~49.2 inside 50
lay.shapes.push(sh('tight', [at(70, 70), at(90, 70)]));          // ~99 ok
lay.shapes.push(sh('field', [at(-30, -30), at(30, -30), at(30, 30), at(-30, 30)]));   // well inside the field: 0 ft
let chk = LC.setbackChecks(lay);
const st = Object.fromEntries(chk.rows.map((r) => [r.shape.kind, [r.status, r.ftRounded]]));
check(st.tank[0] === 'inside' && st.tank[1] === 60, `tank 60 ft -> inside 100 (${st.tank})`);
check(st.leach[0] === 'near' && st.leach[1] === 105, `leach line 105 ft -> near (${st.leach})`);
check(st.pit[0] === 'ok' && st.pit[1] === 170, `seepage pit 170 ft -> ok vs 150 (${st.pit})`);
check(st.sewer[0] === 'inside' && st.sewer[1] === 49, `sewer line 49 ft -> inside 50 (${st.sewer})`);
check(st.tight[0] === 'ok', `tight line ~99 ft -> ok vs 50 (${st.tight})`);
check(st.field[0] === 'inside' && st.field[1] === 0, `well inside the leach field -> 0 ft (${st.field})`);
check(/Septic tank is 60 ft .* inside the 100 ft setback \(40 ft short\)/.test(LC.checkText(chk.rows.find((r) => r.shape.kind === 'tank'))), 'plain-words warning text');
lay.shapes.push(sh('pwell', [at(200, 0)]));
chk = LC.setbackChecks(lay);
check(chk.wells.length === 2 && chk.rows.find((r) => r.shape.kind === 'tank').status === 'inside', 'worst well wins with 2 wells');
const lay2 = LC.newLayout(); lay2.shapes.push(sh('tank', [at(0, 0)]));
check(LC.setbackChecks(lay2).rows[0].status === 'nowell', 'no well yet -> "add a well" status');

// legend linking + restyle
const L = LC.newLayout(); const a = sh('leach', [at(0, 0), at(10, 0)]), b = sh('leach', [at(0, 5), at(10, 5)]); L.shapes.push(a, b);
const e1 = LC.restyle(L, a, { color: '#f97316', dash: 'dashed' });
check(a.legendId === e1.id && e1.auto && e1.color === '#f97316' && e1.dash === 'dashed' && b.legendId === 'leach', 'restyle one line -> its own new legend entry, the other keeps the default');
LC.restyle(L, b, { color: '#f97316', dash: 'dashed' });
check(b.legendId === e1.id, 'same look -> same legend entry (no duplicates)');
LC.restyle(L, a, { color: '#16a34a', dash: 'solid' }); LC.restyle(L, b, { color: '#16a34a', dash: 'solid' });
check(a.legendId === 'leach' && b.legendId === 'leach' && !LC.entryOf(L, e1.id), 'back to default look -> default entry; unused auto entry dropped');
check(LC.usedLegend(L).map((e) => e.id).join() === 'leach', 'used legend = entries in the drawing only');

// parcel lines
const ring = [at(0, 0), at(100, 0), at(100, 0.02), at(100, 100), at(50, 100.01), at(0, 100), at(0, 0)];
const ps = LC.parcelShapes([ring], '285-030-06-00');
check(ps.length === 1 && ps[0].kind === 'prop' && ps[0].closed && ps[0].src === 'parcel' && ps[0].pts.length === 4, `parcel ring -> closed property line, simplified to ${ps[0].pts.length} corners`);
check(near(LC.lengthFt(ps[0].pts, true), 400, 0.5), 'parcel perimeter 400 ft');

// import / export
const back = LC.parseFile(LC.exportJson(lay));
check(back.length === 1 && back[0].shapes.length === lay.shapes.length && back[0].id === lay.id, 'JSON backup round trip');
const junk = { shapes: [{ kind: 'tank', pts: [[999, 0]] }, { kind: 'nope', pts: [[1, 1]] }, { kind: 'leach', pts: [[33, -117]] }, { kind: 'house', pts: [[33, -117], [33.0001, -117], [33.0001, -117.0001]] }], legend: [{ id: 'x', sym: 'line', color: 'red', label: 'X' }] };
const nj = LC.normalize(junk);
check(nj.shapes.length === 1 && nj.shapes[0].kind === 'house' && nj.legend[0].color === '#ffffff', 'import drops bad points / kinds / colours');
let threw = false; try { LC.parseFile('{"hello": 1}'); } catch (e) { threw = true; }
check(threw, 'non-layout file rejected');

// PDF writer
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const pdf = LC.pdfFromJpeg(jpeg, 2200, 1700, 792, 612, 'Plot plan (test)');
const txt = Buffer.from(pdf).toString('latin1');
const sx = +txt.match(/startxref\n(\d+)/)[1];
check(txt.startsWith('%PDF-1.4') && txt.trimEnd().endsWith('%%EOF') && txt.slice(sx, sx + 4) === 'xref', 'PDF header, xref offset, EOF');
const offs = [...txt.matchAll(/(\d{10}) 00000 n /g)].map((m) => +m[1]);
check(offs.length === 6 && offs.every((o, i) => txt.slice(o, o + 8) === `${i + 1} 0 obj\n`), 'every xref offset points at its object');
check(txt.includes('/MediaBox [0 0 792 612]') && txt.includes('/Width 2200 /Height 1700') && txt.includes('/DCTDecode'), 'letter landscape page with the JPEG');

console.log(`${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
