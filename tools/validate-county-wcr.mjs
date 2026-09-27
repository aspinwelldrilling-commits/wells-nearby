// Compare values read from county WCRs (data/county-wcr) with the state WCR database where the permit matched a state record,
// and summarize processing status per area. Usage: node tools/validate-county-wcr.mjs [lat lon r name]...
import { readFileSync } from 'fs';
import vm from 'vm';
for (const f of ['config.js', 'data.js', 'stats.js', 'match.js', 'countywcr.js']) vm.runInThisContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'));
const idx = JSON.parse(readFileSync(new URL('../data/county-wcr/index.json', import.meta.url), 'utf8')).permits;
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => (String(u).includes('index.json') ? Promise.resolve({ ok: true, json: async () => ({ permits: idx }) }) : realFetch(u, o));
await WellsCountyWcr.load();


const a = process.argv.slice(2);
const areas = a.length >= 4 ? [{ lat: +a[0], lon: +a[1], r: +a[2], name: a[3] }]
  : [{ name: 'Valley Center', lat: 33.2184, lon: -117.0342, r: 1 }, { name: 'Ramona', lat: 33.0417, lon: -116.8681, r: 1 }];
const T = WELLS_CONFIG.countyWcr.agreeTolerance;
const agg = {};
for (const A of areas) {
  const qr = A.r + WELLS_CONFIG.matching.bufferMiles;
  const [st, co] = await Promise.all([WellsData.queryNearby(A.lat, A.lon, qr), WellsData.queryCounty(A.lat, A.lon, qr)]);
  WellsMatch.findMatches(st.records, co.records);
  const inArea = co.records.filter((c) => c.distanceMi <= A.r && !c.destruction);
  const status = {};
  inArea.forEach((c) => { const s = idx[c.permit] ? idx[c.permit].status : 'not_processed'; status[s] = (status[s] || 0) + 1; });
  console.log(`\n=== ${A.name}: ${inArea.length} non-destruction county permits within ${A.r} mi`);
  console.log('status:', status);
  const np = inArea.filter((c) => !idx[c.permit]).map((c) => c.permit); if (np.length) console.log('  not processed:', np.join(','));
  // accuracy vs state (matched pairs, state value present, OCR value present at any confidence)
  const rows = [];
  for (const c of inArea) {
    const e = idx[c.permit]; if (!e || !c.matches.length) continue;
    const s = c.matches[0].state; const f = e.fields || {};
    for (const [k, sk, tol] of [['depthFt', 'depthFt', 'depthFt'], ['gpm', 'gpm', 'gpm'], ['swlFt', 'swlFt', 'swlFt']]) {
      if (!f[k] || s[sk] == null) continue;
      const ok = Math.abs(f[k].value - s[sk]) <= Math.max(T.abs[tol], T.rel * s[sk]);
      rows.push({ k, conf: f[k].conf, used: e.status === 'readable' && f[k].conf !== 'low', ok, permit: c.permit, ocr: f[k].value, state: s[sk], match: c.matches[0].conf });
    }
    if (f.dateEnded && s.dateMs != null) {
      const ok = Math.abs(new Date(f.dateEnded.value) - s.dateMs) <= 3 * 86400000;
      rows.push({ k: 'date', conf: f.dateEnded.conf, used: e.status === 'readable' && f.dateEnded.conf !== 'low', ok, permit: c.permit, ocr: f.dateEnded.value, state: s.dateStr, match: c.matches[0].conf });
    }
    if (f.method && s.method) {
      const oc = WellsData.classifyMethod(f.method.value, f.fluid ? f.fluid.value : '').key;
      rows.push({ k: 'method', conf: f.method.conf, used: e.status === 'readable' && f.method.conf !== 'low', ok: oc === s.methodKey || (oc === 'rotaryUnk' && ['air', 'mud'].includes(s.methodKey)), permit: c.permit, ocr: f.method.value, state: s.methodLabel, match: c.matches[0].conf });
    }
  }
  for (const r of rows) { const key = `${r.used ? 'USED' : 'unused'} ${r.k}/${r.conf}`; agg[key] = agg[key] || [0, 0]; agg[key][0] += r.ok ? 1 : 0; agg[key][1]++; }
  rows.filter((r) => !r.ok).forEach((r) => console.log(`  mismatch ${r.used ? 'USED ' : ''}${r.permit} ${r.k} (${r.conf}): OCR ${r.ocr} vs state ${r.state} [${r.match} match]`));
  // what the app shows (after merge), water-supply non-destruction, Both view
  WellsCountyWcr.apply(st.records, co.records, { lat: A.lat, lon: A.lon });
  const both = WellsMatch.buildView('both', st.records, co.records, A.r).filter((w) => w.waterSupply && !w.destruction);
  const fl = {}; both.forEach((w) => (fl[w.wcrFlag || 'none'] = (fl[w.wcrFlag || 'none'] || 0) + 1));
  const S = WellsStats.summarize(both);
  console.log('Both view flags:', fl, `| depth avg ${S.depth.avg?.toFixed(0)} (n=${S.depth.n}) gpm avg ${S.gpm.avg?.toFixed(1)} (n=${S.gpm.n}) swl avg ${S.swl.avg?.toFixed(0)} (n=${S.swl.n})`);
}
console.log('\nAccuracy vs state (agree/total) by field/confidence:');
Object.keys(agg).sort().forEach((k) => console.log(`  ${k}: ${agg[k][0]}/${agg[k][1]}`));
