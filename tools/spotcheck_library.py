"""Spot-check processed permits against the DEH document library (fresh exact-match search per permit).
Flags: docs in the record that belong to another permit (prefix-match bug), library WCR-looking docs while the
record says no_wcr/no_docs, doc-count mismatch, and hard errors.
Usage: python tools/spotcheck_library.py PERMIT[,PERMIT...] | --file list.json [--n 20] [--seed 1]"""
import json, os, random, re, sys, time, urllib.parse, urllib.request, argparse
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = 'https://file.sandiegocounty.gov/CoSD_LUEG_Repository_External_API/rest/DEHQDocumentLibrary/SearchDocuments'
ap = argparse.ArgumentParser(); ap.add_argument('permits', nargs='?', default=''); ap.add_argument('--file'); ap.add_argument('--n', type=int, default=20); ap.add_argument('--seed', type=int, default=1)
a = ap.parse_args()
ps = [p for p in a.permits.split(',') if p]
if a.file:
    t = open(a.file).read().strip()
    try: j = json.loads(t)
    except ValueError: j = json.loads(t[t.index('{'):]) if '{' in t else t.split()  # log-prefixed JSON or one id per line
    ps += [x.upper() for x in (j['permits'] if isinstance(j, dict) else j)]
random.seed(a.seed)
if len(ps) > a.n: ps = random.sample(ps, a.n)
bad = 0
for p in ps:
    q = urllib.parse.urlencode({'record_id': p, 'doc_category': 'DEH-LWQD', 'maxrecord_count': 2000, 'ts': int(time.time() * 1000)})
    lib = json.load(urllib.request.urlopen(urllib.request.Request(API + '?' + q, headers={'User-Agent': 'Mozilla/5.0'}), timeout=60)).get('records', [])
    exact = [d for d in lib if (d.get('permit_id') or '').upper() == p.upper()]
    pdf = [d for d in exact if (d.get('a_content_type') or '').upper() == 'PDF']
    libwcr = [d['description'] for d in pdf if re.search(r'wcr|completion|log', d.get('description') or '', re.I)]
    try: r = json.load(open(os.path.join(ROOT, 'data', 'county-wcr', p + '.json')))
    except FileNotFoundError: print(f'{p}: NOT PROCESSED'); bad += 1; continue
    urls = {d['url'] for d in pdf}
    foreign = [d['url'] for d in r.get('docs', []) if d['url'] not in urls]
    issues = []
    if foreign: issues.append(f'{len(foreign)} docs not filed under this permit')
    if len(r.get('docs', [])) != len(pdf): issues.append(f"doc count {len(r.get('docs', []))} vs library {len(pdf)}")
    if libwcr and r['status'] in ('no_wcr', 'no_docs'): issues.append(f'library has {libwcr} but status {r["status"]}')
    if any(re.match(r'(read|viewer|no pdf|search)', e) for e in r.get('errors', [])): issues.append('errors: ' + '; '.join(r['errors'])[:120])
    f = r.get('fields', {})
    vals = ' '.join(f"{k}={f[k]['value']}" for k in ('depthFt', 'gpm', 'swlFt', 'method') if k in f and isinstance(f[k], dict))
    print(f"{p}: {r['status']:<11} v{r.get('version')} docs={len(r.get('docs', []))} lib={len(pdf)} libWCR={len(libwcr)} {vals} {'OK' if not issues else 'ISSUE: ' + ' | '.join(issues)}")
    bad += bool(issues)
    time.sleep(0.5)
print(f'{len(ps) - bad}/{len(ps)} OK')
