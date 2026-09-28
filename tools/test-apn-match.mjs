// Node unit test (no network): APN formatting for DEH library lookups, exact filtering of the library's prefix
// matches, and multi-well matching (several permits/WCRs on one APN must not collapse).
// Usage: node tools/test-apn-match.mjs
import { readFileSync } from 'fs';
import vm from 'vm';
for (const f of ['config.js', 'data.js', 'stats.js', 'match.js', 'docs.js', 'septic-core.js']) vm.runInThisContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'));
let fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`); };
const W = WellsDocs;
eq('apnFull 10 digits', W.apnFull('2850300600'), '285-030-06-00');
eq('apnFull dashed', W.apnFull('285-030-06-00'), '285-030-06-00');
eq('apnFull 8 digits -> prefix', W.apnFull('28503006'), '285-030-06');
eq('apnFull list', W.apnFull('285-030-06-00, 285-030-08-00'), '285-030-06-00');
eq('apnFull junk', W.apnFull('12345'), null);
const K = globalThis.WellsSepticCore || globalThis.SepticCore;
if (K && K.apnDashed) eq('septic apnDashed 10', K.apnDashed('2850300600'), '285-030-06-00');
eq('record_id exact', W.exactFilter('record_id', 'DEH1981-LWELL-997', [{ permit_id: 'DEH1981-LWELL-997' }, { permit_id: 'DEH1981-LWELL-9972' }]).map((d) => d.permit_id), ['DEH1981-LWELL-997']);
eq('parcel exact 10', W.exactFilter('parcel_number', '285-030-06-00', [{ parcel_nbr: '285-030-06-00' }, { parcel_nbr: '285-030-06-01' }, { parcel_nbr: '285-030-60-00' }]).map((d) => d.parcel_nbr), ['285-030-06-00']);
eq('parcel exact 8', W.exactFilter('parcel_number', '285-030-06', [{ parcel_nbr: '285-030-06-00' }, { parcel_nbr: '285-030-06-01' }, { parcel_nbr: '285-030-60-00' }]).map((d) => d.parcel_nbr), ['285-030-06-00', '285-030-06-01']);
const q = W.docQueries({ group: 'county', permit: 'DEH2024-LWELL-003623', apn: '2850300600' });
eq('docQueries APN format', q.map((x) => x.value), ['DEH2024-LWELL-003623', '285-030-06-00']);

// multi-well: 2 permits + 2 WCRs on one APN -> 2 pairs, nothing hidden
const F = WELLS_CONFIG.sources.county.fieldMap, o = { lat: 32.995, lon: -116.9226 };
const county = (id, apn, date) => WellsData.normalize({ [F.permit]: id, [F.apn]: apn, [F.lat]: 32.995, [F.lon]: -116.9226, [F.dateEnded]: Date.parse(date), [F.recordType]: 'New' }, F, o, 'county');
const st = (wcr, apn, date) => ({ group: 'state', wcr, apn, lat: 32.995, lon: -116.9226, distanceMi: 0, dateMs: Date.parse(date), llAccuracy: 'Parcel center' });
const cs = [county('DEH1991-LWELL-11451', '285-030-08-00', '1991-03-01'), county('DEH1993-LWELL-329', '285-030-08-00', '1993-02-01')];
const ss = [st('A1', '28503008', '1991-05-01'), st('A2', '28503008', '1993-04-01')];
WellsMatch.findMatches(ss, cs);
eq('each WCR pairs its own permit', ss.map((s) => s.match && s.match.county.permit), ['DEH1991-LWELL-11451', 'DEH1993-LWELL-329']);
eq('both view keeps 2 wells', WellsMatch.buildView('both', ss, cs, 1).length, 2);
const ss1 = [st('A1', '28503008', '1992-05-01')];
WellsMatch.findMatches(ss1, cs);
eq('1 WCR + 2 permits -> 2 wells shown', WellsMatch.buildView('both', ss1, cs, 1).length, 2);
// matched WCR with its own GPS outside the radius: permit still listed
const far = { ...st('A3', '28503008', '1991-05-01'), lat: 33.2, lon: -116.9, distanceMi: 14, llAccuracy: '10 ft' };
WellsMatch.findMatches([far], [cs[0]]);

eq('permit visible when its WCR point is outside radius', WellsMatch.buildView('both', [far], [cs[0]], 1).map((w) => w.permit || w.wcr), ['DEH1991-LWELL-11451']);
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
