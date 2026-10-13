#!/usr/bin/env python3
"""San Diego County well completion reports (DWR OSWCR) -> data/sd-oswcr/ (static, 0.025 deg tiles like data/imperial-wcr).

Why: the San Diego County DEHQ permit layer (SanGIS DPLU_Map/MapServer/100, drawn live by the app) stops around 2020, so
this snapshot of the state reports fills 2020 -> today (and every older state report that has no County permit).

Source: CA DWR OSWCR index (ArcGIS MapServer i07_WellCompletionReports, the same proxy as js/config.js) where
CountyName='San Diego', paged 2,000 rows at a time, 1.5 s apart. Raw responses are cached OUTSIDE the repo
(SD_OSWCR_STATE_DIR, default /workspace/wells-state/sd-oswcr/raw) and re-used unless --refresh.

Dedupe against the County permits (SanGIS layer 100: Record_ID DEHyyyy-LWELL-nnnn, lat/lon, Opened_Date, Type_Work):
  1. permit number: state PermitNumber normalised exactly like js/match.js permitKey() ("LWEL 15082", "LWELL-000577",
     "DEH2021-LWELL-001234" -> "15082"...) == County Record_ID number, same destruction/non-destruction kind, and the
     state date (PermitDate, else DateWorkEnded) within -365..+1825 days of the County opened date (or a date missing);
  2. (only with --match-location; off by default because the spec dedupes by permit number only) location + date: no
     permit number on the state record, within 0.25 mi and work ended -7..+120 days after the County opened date, same
     kind, closest unclaimed permit.
A matched report is NOT drawn as its own pin; it goes into matched.json (County Record_ID -> [[WCR, PDF link, how]])
so the app can attach the state WCR link to the County permit popup. Reports with no usable coordinates are listed
in unplaced.json (not drawn).

Categories (field `k`): w = water supply (domestic, irrigation, public, industrial, stock, unknown water supply, test well;
New / Modification or Repair), d = destruction (RecordType Destruction or Drill and Destroy, any use),
m = monitoring + every other non-water use (cathodic, vapor extraction, sparging, injection, remediation, dewatering,
other, unknown, blank). Dates are epoch ms (UTC) -> YYYY-MM-DD; a work-ended date in the future is kept but flagged `bd`.

  python3 tools/build_sd_oswcr.py            # rebuild from the cached raw pull
  python3 tools/build_sd_oswcr.py --refresh  # re-pull the state + County layers first (do this to refresh)
"""
import argparse, datetime as dt, glob, hashlib, json, math, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'sd-oswcr')
TILES = os.path.join(OUT, 'tiles')
STATE = os.environ.get('SD_OSWCR_STATE_DIR', '/workspace/wells-state/sd-oswcr/raw')
QUERY = ('https://utility.arcgis.com/usrsvcs/servers/c074ca40fd684e41babd776eebefd009/rest/services/'
         'Environment/i07_WellCompletionReports/MapServer/0/query')
COUNTY_QUERY = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/100/query'
TILE_DEG = 0.025
PLACE_BOX = (32.45, -117.70, 33.60, -116.0)   # S, W, N, E: SD County + a few miles (incl. offshore-ish coast pins)
UA = 'WellsNearby-SD-OSWCR/1.0 (aspinwelldrilling-commits; static map build)'
FIELDS = [
    ('WCRNumber', 'wcr'), ('RecordType', 'rt'), ('PlannedUseFormerUse', 'use'), ('DateWorkEnded', 'end'),
    ('ReceivedDate', 'rcv'), ('TotalDrillDepth', 'dd'), ('TotalCompletedDepth', 'cd'), ('StaticWaterLevel', 'swl'),
    ('WellYield', 'y'), ('WellYieldUnitofMeasure', 'yu'), ('DrillingMethod', 'm'), ('CasingDiameter', 'csg'),
    ('DrillerName', 'drl'), ('DrillerLicenseNumber', 'lic'), ('WellLocation', 'loc'), ('City', 'city'), ('APN', 'apn'),
    ('PermitNumber', 'pmt'), ('PermitDate', 'pdt'), ('DecimalLatitude', 'lat'), ('DecimalLongitude', 'lon'),
    ('LLAccuracy', 'acc'), ('MethodofDeterminationLL', 'llm'), ('WCRLinks', 'pdf'),
]
DATE_FIELDS = {'DateWorkEnded', 'ReceivedDate', 'PermitDate'}
DAY = 86400000


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get_json(url, params, tries=4):
    data = urllib.parse.urlencode(params).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                j = json.loads(r.read().decode('utf-8'))
            if j.get('error'):
                raise RuntimeError(j['error'])
            return j
        except Exception as e:
            log('retry', i + 1, e)
            time.sleep(5 * (i + 1))
    raise SystemExit('giving up on ' + url)


def paged(url, where, fields, page, name):
    feats, offset = [], 0
    while True:
        j = get_json(url, {'where': where, 'outFields': fields, 'returnGeometry': 'false', 'orderByFields': 'OBJECTID',
                           'resultOffset': offset, 'resultRecordCount': page, 'f': 'json'})
        rows = j.get('features') or []
        feats += [f['attributes'] for f in rows]
        log(name, 'offset', offset, '+', len(rows))
        if not rows or (not j.get('exceededTransferLimit') and len(rows) < page):
            break
        offset += len(rows)
        time.sleep(1.5)
    return feats


def cached(prefix, refresh, fetch):
    os.makedirs(STATE, exist_ok=True)
    files = sorted(glob.glob(os.path.join(STATE, prefix + '_*.json')))
    if files and not refresh:
        log('using cached', files[-1])
        return json.load(open(files[-1])), os.path.basename(files[-1])
    rows = fetch()
    name = '%s_%s.json' % (prefix, dt.date.today().strftime('%Y%m%d'))
    json.dump(rows, open(os.path.join(STATE, name), 'w'))
    return rows, name


def ymd(v):
    if v in (None, ''):
        return None
    try:
        return dt.datetime.fromtimestamp(v / 1000, dt.timezone.utc).strftime('%Y-%m-%d')
    except (OverflowError, OSError, ValueError, TypeError):
        return None


def slim(a):
    out = {}
    for src, key in FIELDS:
        v = a.get(src)
        if src in DATE_FIELDS:
            v = ymd(v)
        if isinstance(v, str):
            v = re.sub(r'\s+', ' ', v).strip()
        if v in (None, ''):
            continue
        if isinstance(v, float) and key in ('lat', 'lon'):
            v = round(v, 6)
        out[key] = v
    return out


def category(a):
    rt = (a.get('RecordType') or '').lower()
    use = (a.get('PlannedUseFormerUse') or '').strip().lower()
    if 'destr' in rt:
        return 'd'
    if use.startswith('water supply') or use == 'test well':
        return 'w'
    return 'm'


def county_key(rid):
    m = re.search(r'LWELL-0*(\d+)$', str(rid or '').upper().strip())
    return m.group(1) if m else None


def state_key(p):   # js/match.js permitKey(v, false)
    s = str(p or '').upper().strip()
    if not s:
        return None
    m = re.search(r'(?:LWEL+|DEH\d{0,4})[-\s]*(?:LWELL[-\s]*)?0*(\d+)\s*$', s) or re.match(r'^0*(\d{3,6})$', s)
    return m.group(1) if m else None


def hav(la1, lo1, la2, lo2):
    r = math.pi / 180
    a = math.sin((la2 - la1) * r / 2) ** 2 + math.cos(la1 * r) * math.cos(la2 * r) * math.sin((lo2 - lo1) * r / 2) ** 2
    return 7917.6 * math.asin(math.sqrt(a))


def tile_key(lat, lon):
    return f'{math.floor(lat / TILE_DEG + 1e-9)}_{math.floor(lon / TILE_DEG + 1e-9)}'


def tile_bounds(key):
    iy, ix = (int(x) for x in key.split('_'))
    return [round(iy * TILE_DEG, 6), round(ix * TILE_DEG, 6), round((iy + 1) * TILE_DEG, 6), round((ix + 1) * TILE_DEG, 6)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='re-pull DWR OSWCR + County permits instead of the cached raw files')
    ap.add_argument('--match-location', action='store_true', help='also hide permit-less reports near a County permit (fuzzy)')
    args = ap.parse_args()
    today = dt.date.today().isoformat()

    recs, raw_name = cached('oswcr_sd', args.refresh, lambda: paged(
        QUERY, "CountyName='San Diego'", ','.join(['OBJECTID'] + [s for s, _ in FIELDS]), 2000, 'oswcr'))
    county, county_name = cached('county_permits', args.refresh, lambda: paged(
        COUNTY_QUERY, '1=1', 'OBJECTID,Record_ID,LatitudeGS84,LongitudeGS84,Opened_Date,Type_Work', 1700, 'county'))

    # de-duplicate the state rows themselves (a handful of WCRNumbers appear twice): keep the most complete row
    by_wcr = {}
    for a in recs:
        w = (a.get('WCRNumber') or '').strip()
        if not w:
            continue
        if w not in by_wcr or sum(v not in (None, '') for v in a.values()) > sum(v not in (None, '') for v in by_wcr[w].values()):
            by_wcr[w] = a
    rows = list(by_wcr.values())

    cby = {}
    for c in county:
        c['_k'] = county_key(c.get('Record_ID'))
        c['_d'] = 'destr' in (c.get('Type_Work') or '').lower()
        if c['_k']:
            cby.setdefault(c['_k'], []).append(c)
    claimed, matched, how_n = set(), {}, {'permit': 0, 'location': 0}

    def take(a, c, how):
        claimed.add(c['Record_ID'])
        matched.setdefault(c['Record_ID'], []).append([a['WCRNumber'], (a.get('WCRLinks') or '').strip(), how])
        how_n[how] += 1

    rest = []
    for a in rows:   # pass 1: permit number
        k, d = state_key(a.get('PermitNumber')), 'destr' in (a.get('RecordType') or '').lower()
        sdate = a.get('PermitDate') or a.get('DateWorkEnded')
        best = None
        for c in cby.get(k, []) if k else []:
            if c['_d'] != d:
                continue
            delta = None if sdate is None or c.get('Opened_Date') is None else (sdate - c['Opened_Date']) / DAY
            if delta is not None and not (-365 <= delta <= 1825):
                continue
            score = abs(delta) if delta is not None else 5000
            if best is None or score < best[0]:
                best = (score, c)
        if best:
            take(a, best[1], 'permit')
        else:
            rest.append(a)
    grid = {}
    for c in county:
        if c.get('LatitudeGS84') and c.get('LongitudeGS84') and c.get('Opened_Date') and c['Record_ID'] not in claimed:
            grid.setdefault((int(c['LatitudeGS84'] / 0.01), int(c['LongitudeGS84'] / 0.01)), []).append(c)
    left = []
    for a in rest:   # pass 2: location + tight date window, only for state rows with no permit number
        lat, lon, end = a.get('DecimalLatitude'), a.get('DecimalLongitude'), a.get('DateWorkEnded')
        if not args.match_location or a.get('PermitNumber') or lat is None or lon is None or end is None:
            left.append(a); continue
        d = 'destr' in (a.get('RecordType') or '').lower()
        best = None
        gy, gx = int(lat / 0.01), int(lon / 0.01)
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                for c in grid.get((gy + dy, gx + dx), []):
                    if c['Record_ID'] in claimed or c['_d'] != d:
                        continue
                    delta = (end - c['Opened_Date']) / DAY
                    dist = hav(lat, lon, c['LatitudeGS84'], c['LongitudeGS84'])
                    if dist <= 0.25 and -7 <= delta <= 120 and (best is None or dist < best[0]):
                        best = (dist, c)
        if best:
            take(a, best[1], 'location')
        else:
            left.append(a)

    tiles, unplaced, cats, years = {}, [], {'w': 0, 'd': 0, 'm': 0}, {}
    for a in left:
        r = slim(a)
        r['k'] = category(a)
        if r.get('end') and r['end'] > today:
            r['bd'] = 1   # bogus future work-ended date (e.g. WCR2024-001647 -> 2029)
        lat, lon = a.get('DecimalLatitude'), a.get('DecimalLongitude')
        if lat is None or lon is None or not (PLACE_BOX[0] <= lat <= PLACE_BOX[2] and PLACE_BOX[1] <= lon <= PLACE_BOX[3]):
            unplaced.append({'wcr': r['wcr'], 'why': 'no coordinates' if lat is None or lon is None else 'coordinates outside SD County',
                             **{x: r[x] for x in ('k', 'end', 'pmt', 'city', 'pdf') if x in r}})
            continue
        cats[r['k']] += 1
        yr = (r.get('end') if not r.get('bd') else None) or r.get('rcv') or ''
        y = yr[:4] if yr else 'none'
        years.setdefault(y, {'w': 0, 'd': 0, 'm': 0})[r['k']] += 1
        tiles.setdefault(tile_key(lat, lon), {})[r['wcr']] = r

    os.makedirs(TILES, exist_ok=True)
    man = {}
    for k in sorted(tiles):
        body = json.dumps(tiles[k], sort_keys=True, separators=(',', ':'))
        with open(os.path.join(TILES, k + '.json'), 'w') as f:
            f.write('{"tile":"%s","bounds":%s,"wcrs":%s}' % (k, json.dumps(tile_bounds(k), separators=(',', ':')), body))
        man[k] = {'b': tile_bounds(k), 'n': len(tiles[k]), 'h': hashlib.sha1(body.encode()).hexdigest()[:10],
                  'c': ''.join(sorted({r['k'] for r in tiles[k].values()}))}
    for path in glob.glob(os.path.join(TILES, '*.json')):
        if os.path.basename(path)[:-5] not in man:
            os.remove(path)
    with open(os.path.join(OUT, 'matched.json'), 'w') as f:
        json.dump({'generated': today, 'note': 'County Record_ID -> [[WCRNumber, WCR PDF link, matched by]]',
                   'permits': dict(sorted(matched.items()))}, f, separators=(',', ':'))
    placed = sum(cats.values())
    manifest = {
        'version': 1, 'generated': dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'county': 'sandiego',
        'source': "CA DWR OSWCR well completion reports (CountyName='San Diego'), minus reports matched to a County DEHQ permit",
        'sourceUrl': QUERY.rsplit('/query', 1)[0], 'countySourceUrl': COUNTY_QUERY.rsplit('/query', 1)[0],
        'raw': raw_name, 'countyRaw': county_name, 'sourceTotal': len(recs), 'uniqueWcrs': len(rows),
        'countyPermits': len(county), 'matchedReports': sum(how_n.values()), 'matchedBy': how_n,
        'matchedPermits': len(matched), 'count': placed, 'categories': cats,
        'years': dict(sorted(years.items())), 'withPdf': sum(1 for t in tiles.values() for r in t.values() if r.get('pdf')),
        'badDates': sum(1 for t in tiles.values() for r in t.values() if r.get('bd')),
        'tileDeg': TILE_DEG, 'boundsOrder': 'south,west,north,east',
        'fields': {key: src for src, key in FIELDS} | {'k': 'category: w water supply, d destruction, m monitoring/other',
                                                       'bd': 'work-ended date is in the future (bad date in DWR index)'},
        'unplaced': len(unplaced), 'unplacedUrl': 'unplaced.json', 'matchedUrl': 'matched.json', 'tiles': man,
    }
    with open(os.path.join(OUT, 'unplaced.json'), 'w') as f:   # reports DWR has no usable coordinates for (not drawn)
        json.dump(sorted(unplaced, key=lambda u: u['wcr']), f, separators=(',', ':'))
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
    log(json.dumps({k: manifest[k] for k in ('sourceTotal', 'uniqueWcrs', 'countyPermits', 'matchedReports', 'matchedBy',
                                             'matchedPermits', 'count', 'categories', 'withPdf', 'badDates')}),
        'tiles', len(man), 'unplaced', len(unplaced))
    log(json.dumps(manifest['years']))


if __name__ == '__main__':
    main()
