// Node test: runs the SAME query/normalize/match/stats code the browser uses.
// Usage: node tools/test-query.mjs [lat lon radiusMi] [--ckan] [--all] [--pairs]
import { readFileSync } from 'fs';
import vm from 'vm';
for (const f of ['config.js', 'data.js', 'stats.js', 'match.js']) vm.runInThisContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const prefer = args.includes('--ckan') ? 'ckan' : 'arcgis';
const all = args.includes('--all'), showPairs = args.includes('--pairs');
const nums = args.filter((a) => !a.startsWith('--')).map(Number);
const sites = nums.length >= 2 ? [{ name: 'custom', lat: nums[0], lon: nums[1], r: nums[2] || 1 }]
  : [{ name: 'Ramona', lat: 33.0417, lon: -116.8681, r: 1 }, { name: 'Valley Center', lat: 33.2184, lon: -117.0342, r: 1 }];
const f = (x, d = 0) => (x == null ? '—' : x.toFixed(d));
const keep = (w) => all || (w.waterSupply && !w.destruction);
for (const s of sites) {
  const t0 = Date.now();
  const qr = s.r + WELLS_CONFIG.matching.bufferMiles;
  const [st, co] = await Promise.all([WellsData.queryNearby(s.lat, s.lon, qr, { prefer }), WellsData.queryCounty(s.lat, s.lon, qr)]);
  const m = WellsMatch.findMatches(st.records, co.records);
  console.log(`\n=== ${s.name} (${s.lat}, ${s.lon}) r=${s.r} mi (fetched ${qr} mi for matching) — ${st.source} + ${co.source} — ${Date.now() - t0} ms`);
  const inR = (w) => w.distanceMi <= s.r;
  console.log(`raw in radius: state ${st.records.filter(inR).length}, county ${co.records.filter(inR).length}; matched pairs (whole fetch): ${m.pairs}`);
  for (const view of ['state', 'county', 'both']) {
    const wells = WellsMatch.buildView(view, st.records, co.records, s.r).filter(keep);
    const S = WellsStats.summarize(wells);
    const dup = wells.filter((w) => w.matchLabel).length;
    console.log(`-- ${view.toUpperCase()}: ${wells.length} wells (${S.uniqueLocations} map points; ${dup} flagged dup: likely ${wells.filter((w) => /Likely/.test(w.matchLabel)).length}, possible ${wells.filter((w) => /Possible/.test(w.matchLabel)).length})`);
    console.log(`   depth ft min ${f(S.depth.min)} max ${f(S.depth.max)} avg ${f(S.depth.avg)} med ${f(S.depth.median)} (n=${S.depth.n}) | gpm avg ${f(S.gpm.avg, 1)} med ${f(S.gpm.median, 1)} (n=${S.gpm.n}) | SWL avg ${f(S.swl.avg)} (n=${S.swl.n}) | year ${f(S.year.min)}–${f(S.year.max)} (n=${S.year.n})`);
    console.log('   methods: ' + S.methods.filter((x) => x.count).map((x) => `${x.label} ${x.count} (${x.pct.toFixed(0)}%)`).join(', '));
  }
  if (showPairs) st.records.filter((w) => w.match && inR(w)).forEach((w) => console.log(`   ${w.wcr} [${w.apn || '-'} / ${w.permit || '-'} / ${w.dateStr}] ~ ${w.match.county.permit} [${w.match.county.apn} / ${w.match.county.dateStr}] ${w.match.conf}: ${w.match.reason}`));
}
