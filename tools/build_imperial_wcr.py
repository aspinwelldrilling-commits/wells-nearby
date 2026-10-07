#!/usr/bin/env python3
"""Imperial County well completion reports (DWR OSWCR) -> data/imperial-wcr/ (static, tiled like data/riverside-wcr).

Source: CA DWR OSWCR index (ArcGIS MapServer i07_WellCompletionReports via the ArcGIS Online proxy used by js/config.js),
where CountyName='Imperial'. All ~1,500 Imperial rows fit in ONE paged request (maxRecordCount 2000), so the raw response
is cached outside the repo and re-used (--refresh to re-fetch; polite: one request at a time, 1 s apart).

Only values present in the source are written (no geocoding, no TRS->lat/lon, no invented addresses/APNs). Dates are
converted from epoch ms (UTC) to YYYY-MM-DD. The DWR `LLAccuracy` / `MethodofDeterminationLL` are kept so the app can
say a pin is a section centroid. PDFs are NOT downloaded: the DWR Box viewer link (`WCRLinks`) is stored as-is.

Placement: records with coordinates inside a box around Imperial County (county bbox + ~5 mi) go into 0.025 deg tiles
(same grid as tools/extract_riverside_wcr.py). A placed record outside the county line (Census county polygon, cached)
gets `oc:1` so the popup can say so. Records with no coordinates or coordinates far away (e.g. DWR rows keyed into
Fresno / LA) are listed in manifest.json `unplaced` with the reason, not drawn.

  python3 tools/build_imperial_wcr.py --phase ocotillo   # west corridor only (Ocotillo / Coyote Wells / Plaster City)
  python3 tools/build_imperial_wcr.py --phase all        # every Imperial OSWCR record
"""
import argparse, datetime as dt, glob, hashlib, json, math, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'imperial-wcr')
TILES = os.path.join(OUT, 'tiles')
STATE = os.environ.get('IMPERIAL_STATE_DIR', '/workspace/wells-state/imperial/raw')   # raw cache, never in the repo
QUERY = ('https://utility.arcgis.com/usrsvcs/servers/c074ca40fd684e41babd776eebefd009/rest/services/'
         'Environment/i07_WellCompletionReports/MapServer/0/query')
BOUNDARY_URL = ('https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Census_Counties/FeatureServer/0/query'
                '?where=FIPS%3D%2706025%27&outFields=NAME,FIPS&outSR=4326&f=geojson')
TILE_DEG = 0.025
PLACE_BOX = (32.55, -116.20, 33.50, -114.38)          # S, W, N, E: Imperial County bbox + ~5 mi
# Phase 1 = Ocotillo / Coyote Wells / Plaster City west corridor: west bbox OR T16S-T17S R9E-R10E SBBM
OCOTILLO_BOX = (32.60, -116.20, 32.95, -115.70)
OCOTILLO_TRS = ({'16S', '17S'}, {'9E', '09E', '10E'})
UA = 'WellsNearby-Imperial/1.0 (aspinwelldrilling-commits; static map build)'

# OSWCR field -> short key in the tiles (documented in manifest.json "fields")
FIELDS = [
    ('WCRNumber', 'wcr'), ('LegacyLogNumber', 'leg'), ('RecordType', 'rt'), ('PlannedUseFormerUse', 'use'),
    ('B118WellUse', 'b118'), ('DateWorkEnded', 'end'), ('ReceivedDate', 'rcv'), ('TotalDrillDepth', 'dd'),
    ('TotalCompletedDepth', 'cd'), ('StaticWaterLevel', 'swl'), ('WellYield', 'y'), ('WellYieldUnitofMeasure', 'yu'),
    ('DrillingMethod', 'm'), ('Fluid', 'fl'), ('CasingDiameter', 'csg'), ('TopOfPerforatedInterval', 'pt'),
    ('BottomofPerforatedInterval', 'pb'), ('DrillerName', 'drl'), ('DrillerLicenseNumber', 'lic'),
    ('WellLocation', 'loc'), ('City', 'city'), ('APN', 'apn'), ('PermitNumber', 'pmt'), ('PermitDate', 'pdt'),
    ('LocalPermitAgency', 'lpa'), ('Township', 'twp'), ('Range', 'rng'), ('Section', 'sec'),
    ('BaselineMeridian', 'bm'), ('DecimalLatitude', 'lat'), ('DecimalLongitude', 'lon'), ('LLAccuracy', 'acc'),
    ('MethodofDeterminationLL', 'llm'), ('HorizontalDatum', 'dat'), ('WCRLinks', 'pdf'),
]
DATE_FIELDS = {'DateWorkEnded', 'ReceivedDate', 'PermitDate'}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get_json(url, params=None):
    if params:
        url = url + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode('utf-8'))


def fetch_records(refresh=False):
    """All Imperial OSWCR rows (attributes), from the newest cached raw file unless --refresh."""
    os.makedirs(STATE, exist_ok=True)
    cached = sorted(glob.glob(os.path.join(STATE, 'oswcr_imperial_*.json')))
    if cached and not refresh:
        log('using cached', cached[-1])
        return [f['attributes'] for f in json.load(open(cached[-1]))['features']], os.path.basename(cached[-1])
    feats, offset = [], 0
    while True:
        j = get_json(QUERY, {'where': "CountyName='Imperial'", 'outFields': '*', 'returnGeometry': 'false',
                             'orderByFields': 'OBJECTID', 'resultOffset': offset, 'resultRecordCount': 2000, 'f': 'json'})
        if j.get('error'):
            raise SystemExit('ArcGIS error: %s' % j['error'])
        page = j.get('features') or []
        feats += page
        if not j.get('exceededTransferLimit') or not page:
            break
        offset += len(page)
        time.sleep(1.0)
    name = 'oswcr_imperial_%s.json' % dt.date.today().strftime('%Y%m%d')
    json.dump({'features': feats}, open(os.path.join(STATE, name), 'w'))
    log('fetched', len(feats), '->', name)
    return [f['attributes'] for f in feats], name


def county_rings():
    path = os.path.join(STATE, 'imperial_county_boundary.geojson')
    if not os.path.exists(path):
        json.dump(get_json(BOUNDARY_URL), open(path, 'w'))
    g = json.load(open(path))['features'][0]['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    return [ring for poly in polys for ring in poly[:1]]   # outer rings (Imperial has no holes that matter here)


def inside(lon, lat, rings):
    hit = False
    for ring in rings:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]; xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                hit = not hit
            j = i
    return hit


def ymd(v):
    if v in (None, ''):
        return None
    return dt.datetime.fromtimestamp(v / 1000, dt.timezone.utc).strftime('%Y-%m-%d')


def slim(a):
    out = {}
    for src, key in FIELDS:
        v = a.get(src)
        if src in DATE_FIELDS:
            v = ymd(v)
        if isinstance(v, str):
            v = v.strip()
        if v in (None, ''):
            continue
        out[key] = v
    return out


def in_box(lat, lon, box):
    return box[0] <= lat <= box[2] and box[1] <= lon <= box[3]


def is_ocotillo(a):
    lat, lon = a.get('DecimalLatitude'), a.get('DecimalLongitude')
    if lat is not None and lon is not None and in_box(lat, lon, OCOTILLO_BOX):
        return True
    return (a.get('Township') or '').strip() in OCOTILLO_TRS[0] and (a.get('Range') or '').strip() in OCOTILLO_TRS[1]


def tile_key(lat, lon):
    return f'{math.floor(lat / TILE_DEG + 1e-9)}_{math.floor(lon / TILE_DEG + 1e-9)}'


def tile_bounds(key):
    iy, ix = (int(x) for x in key.split('_'))
    return [round(iy * TILE_DEG, 6), round(ix * TILE_DEG, 6), round((iy + 1) * TILE_DEG, 6), round((ix + 1) * TILE_DEG, 6)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--phase', choices=['ocotillo', 'all'], default='all')
    ap.add_argument('--refresh', action='store_true', help='re-fetch from DWR instead of the cached raw file')
    args = ap.parse_args()

    recs, raw_name = fetch_records(args.refresh)
    rings = county_rings()
    sel = [a for a in recs if args.phase == 'all' or is_ocotillo(a)]
    tiles, unplaced = {}, []
    for a in sel:
        r = slim(a)
        lat, lon = a.get('DecimalLatitude'), a.get('DecimalLongitude')
        if lat is None or lon is None:
            unplaced.append({'wcr': r['wcr'], 'why': 'no coordinates in DWR index', **{k: r[k] for k in ('twp', 'rng', 'sec', 'city', 'pdf') if k in r}})
            continue
        if not in_box(lat, lon, PLACE_BOX):
            unplaced.append({'wcr': r['wcr'], 'why': 'DWR coordinates far outside Imperial County', 'lat': lat, 'lon': lon,
                             **{k: r[k] for k in ('twp', 'rng', 'sec', 'city', 'pdf') if k in r}})
            continue
        if is_ocotillo(a):
            r['p1'] = 1
        if not inside(lon, lat, rings):
            r['oc'] = 1
        tiles.setdefault(tile_key(lat, lon), {})[r['wcr']] = r

    os.makedirs(TILES, exist_ok=True)
    man = {}
    for k in sorted(tiles):
        body = json.dumps(tiles[k], sort_keys=True, separators=(',', ':'))
        h = hashlib.sha1(body.encode()).hexdigest()[:10]
        with open(os.path.join(TILES, k + '.json'), 'w') as f:
            f.write('{"tile":"%s","bounds":%s,"wcrs":%s}' % (k, json.dumps(tile_bounds(k), separators=(',', ':')), body))
        man[k] = {'b': tile_bounds(k), 'n': len(tiles[k]), 'h': h}
    for path in glob.glob(os.path.join(TILES, '*.json')):
        if os.path.basename(path)[:-5] not in man:
            os.remove(path)
    placed = [r for t in tiles.values() for r in t.values()]
    now = dt.datetime.now().astimezone().isoformat(timespec='seconds')
    manifest = {
        'version': 1, 'generated': now, 'county': 'imperial', 'phase': args.phase,
        'source': 'CA DWR OSWCR well completion reports (CountyName=Imperial)', 'sourceUrl': QUERY.rsplit('/query', 1)[0],
        'raw': raw_name, 'sourceTotal': len(recs), 'selected': len(sel), 'count': len(placed),
        'withPdf': sum(1 for r in placed if r.get('pdf')), 'centroid': sum(1 for r in placed if r.get('acc') == 'Centroid of Section'),
        'outsideCountyLine': sum(1 for r in placed if r.get('oc')),
        'tileDeg': TILE_DEG, 'boundsOrder': 'south,west,north,east',
        'fields': {key: src for src, key in FIELDS} | {'p1': 'in Ocotillo/Coyote Wells/Plaster City phase-1 corridor',
                                                       'oc': 'DWR coordinates fall outside the Imperial County line'},
        'tiles': man, 'unplaced': sorted(unplaced, key=lambda u: u['wcr']),
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
    log(json.dumps({k: manifest[k] for k in ('phase', 'sourceTotal', 'selected', 'count', 'withPdf', 'centroid', 'outsideCountyLine')}),
        'tiles', len(man), 'unplaced', len(unplaced))


if __name__ == '__main__':
    main()
