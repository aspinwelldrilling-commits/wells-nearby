// Node test: runs the SAME query/normalize/stats code the browser uses.
// Usage: node tools/test-query.mjs [lat lon radiusMi] [--ckan] [--all]
import { readFileSync } from 'fs';
import vm from 'vm';
for (const f of ['config.js', 'data.js', 'stats.js']) vm.runInThisContext(readFileSync(new URL('../js/' + f, import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const prefer = args.includes('--ckan') ? 'ckan' : 'arcgis';
const all = args.includes('--all');
const nums = args.filter((a) => !a.startsWith('--')).map(Number);
const sites = nums.length >= 2 ? [{ name: 'custom', lat: nums[0], lon: nums[1], r: nums[2] || 1 }]
  : [{ name: 'Ramona', lat: 33.0417, lon: -116.8681, r: 1 }, { name: 'Valley Center', lat: 33.2184, lon: -117.0342, r: 1 }];
const f = (x, d = 0) => (x == null ? '—' : x.toFixed(d));
for (const s of sites) {
  const t0 = Date.now();
  const res = await WellsData.queryNearby(s.lat, s.lon, s.r, { prefer });
  const wells = res.records.filter((w) => all || (w.waterSupply && !w.destruction));
  const S = WellsStats.summarize(wells);
  console.log(`\n=== ${s.name} (${s.lat}, ${s.lon}) r=${s.r} mi — source: ${res.source} ${res.errors.length ? '(errors: ' + res.errors + ')' : ''} ${Date.now() - t0} ms`);
  console.log(`records in radius: ${res.records.length}; ${all ? 'all' : 'water-supply, non-destruction'}: ${wells.length}; unique locations: ${S.uniqueLocations}`);
  console.log(`depth ft: min ${f(S.depth.min)} max ${f(S.depth.max)} avg ${f(S.depth.avg)} median ${f(S.depth.median)} (n=${S.depth.n})`);
  console.log(`yield gpm: avg ${f(S.gpm.avg, 1)} median ${f(S.gpm.median, 1)} min ${f(S.gpm.min, 1)} max ${f(S.gpm.max)} (n=${S.gpm.n}; zero-yield ${S.yieldZeroCount})`);
  console.log(`SWL ft: avg ${f(S.swl.avg)} median ${f(S.swl.median)} range ${f(S.swl.min)}–${f(S.swl.max)} (n=${S.swl.n})`);
  console.log(`year: ${f(S.year.min)}–${f(S.year.max)} (n=${S.year.n})`);
  console.log('methods: ' + S.methods.filter((m) => m.count).map((m) => `${m.label} ${m.count} (${m.pct.toFixed(0)}%)`).join(', '));
  console.log('location accuracy: ' + S.accuracy.map(([k, v]) => `${k}: ${v}`).join(', '));
}
