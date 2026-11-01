#!/usr/bin/env python3
"""San Bernardino County well completion reports (DWR OSWCR) -> data/sb-oswcr/ (static, 0.025 deg tiles, same record
shape / categories as data/sd-oswcr, built from tools/build_sd_oswcr.py).

Source: CA DWR OSWCR index (ArcGIS MapServer i07_WellCompletionReports, same proxy as js/config.js) where
CountyName='San Bernardino', paged 2,000 rows, 1.5 s apart. Raw pull cached OUTSIDE the repo
(SB_OSWCR_STATE_DIR, default /workspace/wells-state/sb-oswcr/raw), re-used unless --refresh.
No county matching (the SB County permit layer is the weekly PDF, see tools/sb_weekly_permits.py).
Categories (k): w water supply, d destruction, m monitoring/other. Section-centroid points are kept as DWR has them
(the app draws them dashed / hollow = approximate). Only touches data/sb-oswcr.

  python3 tools/build_sb_oswcr.py            # rebuild from the cached raw pull
  python3 tools/build_sb_oswcr.py --refresh  # re-pull DWR first
"""
import argparse, datetime as dt, glob, hashlib, json, math, os, re, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'sb-oswcr')
TILES = os.path.join(OUT, 'tiles')
STATE = os.environ.get('SB_OSWCR_STATE_DIR', '/workspace/wells-state/sb-oswcr/raw')
QUERY = ('https://utility.arcgis.com/usrsvcs/servers/c074ca40fd684e41babd776eebefd009/rest/services/'
         'Environment/i07_WellCompletionReports/MapServer/0/query')
TILE_DEG = 0.025
PLACE_BOX = (33.80, -117.85, 35.85, -114.10)   # S, W, N, E: SB County + a few miles
UA = 'WellsNearby-SB-OSWCR/1.0 (aspinwelldrilling-commits; static map build)'
FIELDS = [
    ('WCRNumber', 'wcr'), ('RecordType', 'rt'), ('PlannedUseFormerUse', 'use'), ('DateWorkEnded', 'end'),
    ('ReceivedDate', 'rcv'), ('TotalDrillDepth', 'dd'), ('TotalCompletedDepth', 'cd'), ('StaticWaterLevel', 'swl'),
    ('WellYield', 'y'), ('WellYieldUnitofMeasure', 'yu'), ('DrillingMethod', 'm'), ('CasingDiameter', 'csg'),
    ('DrillerName', 'drl'), ('DrillerLicenseNumber', 'lic'), ('WellLocation', 'loc'), ('City', 'city'), ('APN', 'apn'),
    ('PermitNumber', 'pmt'), ('PermitDate', 'pdt'), ('DecimalLatitude', 'lat'), ('DecimalLongitude', 'lon'),
    ('LLAccuracy', 'acc'), ('MethodofDeterminationLL', 'llm'), ('WCRLinks', 'pdf'),
]
EXTRA = ['Township', 'Range', 'Section', 'BaselineMeridian']   # used for placement, not shipped
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


COUNTY_POLY = os.path.join(os.path.dirname(STATE.rstrip('/')), 'sb_county_tiger.json')
COUNTY_POLY_URL = ('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query'
                   "?where=GEOID%3D'06071'&outFields=NAME&returnGeometry=true&outSR=4326&f=json")


def county_rings():
    # Census TIGERweb San Diego County polygon (GEOID 06073), cached next to the raw pulls
    if not os.path.exists(COUNTY_POLY):
        req = urllib.request.Request(COUNTY_POLY_URL, headers={'User-Agent': UA})
        open(COUNTY_POLY, 'wb').write(urllib.request.urlopen(req, timeout=120).read())
    return json.load(open(COUNTY_POLY))['features'][0]['geometry']['rings']


def in_rings(lat, lon, rings):
    c = False
    for ring in rings:
        for i in range(len(ring)):
            x1, y1 = ring[i]; x2, y2 = ring[i - 1]
            if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                c = not c
    return c


def section_level(a):
    return 'centroid' in (a.get('LLAccuracy') or '').lower() or 'trs' in (a.get('MethodofDeterminationLL') or '').lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true', help='look up missing APN parcels / PLSS sections (cached)')
    ap.add_argument('--refresh', action='store_true', help='re-pull DWR OSWCR instead of the cached raw file')
    args = ap.parse_args()
    today = dt.date.today().isoformat()
    recs, raw_name = cached('oswcr_sb', args.refresh, lambda: paged(
        QUERY, "CountyName='San Bernardino'", ','.join(['OBJECTID'] + [s for s, _ in FIELDS] + EXTRA), 2000, 'oswcr'))
    by_wcr = {}
    for a in recs:
        w = (a.get('WCRNumber') or '').strip()
        if not w:
            continue
        if w not in by_wcr or sum(v not in (None, '') for v in a.values()) > sum(v not in (None, '') for v in by_wcr[w].values()):
            by_wcr[w] = a
    rows = list(by_wcr.values())
    tiles, unplaced, cats, years = {}, [], {'w': 0, 'd': 0, 'm': 0}, {}
    rings = county_rings()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import sb_oswcr_place as P
    if not any(a.get('Township') for a in rows):
        raise SystemExit('raw pull has no Township/Range/Section fields - run with --refresh')
    if args.fetch:
        P.fetch_sections([P.sec_fid(a.get('Township'), a.get('Range'), a.get('Section'), a.get('BaselineMeridian')) for a in rows])
        P.fetch_apns([P.apn9(a.get('APN')) for a in rows])
    secs, apns = P.load('sec_cache.json'), P.load('apn9_cache.json')
    st = {'upgradedApn': 0, 'rejectedApnOutsideSection': 0, 'apnLargeParcel': 0, 'recoveredApn': 0, 'recoveredSection': 0, 'recoveredFix': 0}

    def place(a):
        """-> (lat, lon, extra dict) or None. Only APN parcels that fall in/near the report's own T/R/S section count."""
        fid = P.sec_fid(a.get('Township'), a.get('Range'), a.get('Section'), a.get('BaselineMeridian'))
        sec = secs.get(fid) if fid else None
        k9 = P.apn9(a.get('APN'))
        par = apns.get(k9) if k9 else None
        if par and in_rings(par['lat'], par['lon'], rings):
            if sec and P.dist_deg(par['lat'], par['lon'], sec['rings']) <= P.EDGE_DEG:
                return par['lat'], par['lon'], {'pl': 'apn', 'pac': par['ac'], 'pchk': 'sec'}
            if not sec:
                return par['lat'], par['lon'], {'pl': 'apn', 'pac': par['ac'], 'pchk': 'none'}
            st['rejectedApnOutsideSection'] += 1
        return None

    for a in rows:
        r = slim(a)
        r['k'] = category(a)
        if r.get('end') and r['end'] > today:
            r['bd'] = 1
        lat, lon = a.get('DecimalLatitude'), a.get('DecimalLongitude')
        outside = lat is not None and lon is not None and not section_level(a) and not in_rings(lat, lon, rings)
        bad = outside or lat is None or lon is None or not (PLACE_BOX[0] <= lat <= PLACE_BOX[2] and PLACE_BOX[1] <= lon <= PLACE_BOX[3])
        if bad or section_level(a):
            got = place(a)
            fid = P.sec_fid(a.get('Township'), a.get('Range'), a.get('Section'), a.get('BaselineMeridian'))
            sec = secs.get(fid) if fid else None
            if got and bad and got[2]['pchk'] == 'none' and lat is not None:
                got = None   # unverifiable APN for a record with coordinates elsewhere: don't guess
            if got:
                if lat is not None:
                    r['dll'] = [lat, lon]   # DWR's own point, kept for reference
                lat, lon = got[0], got[1]
                r.update({x: got[2][x] for x in ('pl', 'pac')})
                if got[2]['pac'] > P.MAX_AC:
                    r['ap'] = 1; st['apnLargeParcel'] += 1
                st['recoveredApn' if bad else 'upgradedApn'] += 1
                r['lat'], r['lon'] = lat, lon
                bad = False; a = dict(a, LLAccuracy='parcel'); a.pop('MethodofDeterminationLL', None)
            elif bad and lat is None and sec and in_rings(sec['lat'], sec['lon'], rings):
                lat, lon = sec['lat'], sec['lon']; r['lat'], r['lon'] = lat, lon
                r['pl'] = 'sec'; r['ap'] = 1; st['recoveredSection'] += 1; bad = False
            elif bad and lat is not None and not section_level(a):
                for la, lo in ((lat, -abs(lon)), (abs(lon), -abs(lat))):   # missing minus / swapped lat-lon
                    if (la, lo) != (lat, lon) and PLACE_BOX[0] <= la <= PLACE_BOX[2] and in_rings(la, lo, rings) and \
                            (not sec or P.dist_deg(la, lo, sec['rings']) <= P.EDGE_DEG):
                        r['dll'] = [lat, lon]; lat, lon = la, lo; r['lat'], r['lon'] = lat, lon
                        r['pl'] = 'fix'; st['recoveredFix'] += 1; bad = False; break
        if bad:
            unplaced.append({'wcr': r['wcr'], 'why': 'no coordinates' if lat is None or lon is None else 'coordinates outside SB County',
                             **{x: r[x] for x in ('k', 'end', 'pmt', 'city', 'pdf') if x in r}})
            continue
        if section_level(a) and r.get('pl') != 'apn':
            r['ap'] = 1   # approximate (section centroid / TRS)
        cats[r['k']] += 1
        yr = (r.get('end') if not r.get('bd') else None) or r.get('rcv') or ''
        years.setdefault(yr[:4] or 'none', {'w': 0, 'd': 0, 'm': 0})[r['k']] += 1
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
    manifest = {
        'version': 1, 'generated': dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'county': 'sanbernardino',
        'source': "CA DWR OSWCR well completion reports (CountyName='San Bernardino')",
        'sourceUrl': QUERY.rsplit('/query', 1)[0], 'raw': raw_name, 'sourceTotal': len(recs), 'uniqueWcrs': len(rows),
        'count': sum(cats.values()), 'categories': cats, 'years': dict(sorted(years.items())),
        'approx': sum(1 for t in tiles.values() for r in t.values() if r.get('ap')),
        'withPdf': sum(1 for t in tiles.values() for r in t.values() if r.get('pdf')),
        'badDates': sum(1 for t in tiles.values() for r in t.values() if r.get('bd')),
        'tileDeg': TILE_DEG, 'boundsOrder': 'south,west,north,east',
        'fields': {key: src for src, key in FIELDS} | {'k': 'category: w water supply, d destruction, m monitoring/other',
                                                       'bd': 'work-ended date in the future', 'ap': 'section-level (approximate) point',
                                                       'pl': "placement by this build: 'apn' parcel centre (APN, checked against the report's T/R/S section when it has one), 'sec' PLSS section centre from T/R/S (no DWR coordinates), 'fix' DWR coordinates with a missing minus / swapped lat-lon",
                                                       'pac': 'parcel acres (pl=apn)', 'dll': "DWR's original lat/lon when moved"},
        'placement': st | {'parcelExact': sum(1 for t in tiles.values() for r in t.values() if r.get('pl') == 'apn' and not r.get('ap')),
                           'sectionLevel': sum(1 for t in tiles.values() for r in t.values() if r.get('ap'))},
        'unplaced': len(unplaced), 'unplacedUrl': 'unplaced.json', 'tiles': man,
    }
    with open(os.path.join(OUT, 'unplaced.json'), 'w') as f:
        json.dump(sorted(unplaced, key=lambda u: u['wcr']), f, separators=(',', ':'))
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
    log(json.dumps({k: manifest[k] for k in ('sourceTotal', 'uniqueWcrs', 'count', 'categories', 'approx', 'withPdf', 'badDates', 'unplaced')}), 'tiles', len(man))


if __name__ == '__main__':
    main()
