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
PLSS_URL = ('https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/2/query')  # BLM CadNSDI sections
TRS_ACC = 'Centroid of Section (derived from TRS)'
# Records DWR filed under ANOTHER county whose coordinates, TRS and city all say Imperial (checked by hand, Nov 2026).
# Only rows with an affirmative Imperial city are added; border rows with a blank city are NOT added.
EXTRA_WCRS = ['WCR2003-016141']
IMPERIAL_CITIES = {'EL CENTRO', 'BRAWLEY', 'CALEXICO', 'IMPERIAL', 'HOLTVILLE', 'CALIPATRIA', 'WESTMORLAND', 'OCOTILLO',
                   'OCOTILLA', 'SEELEY', 'SEELY', 'HEBER', 'NILAND', 'WINTERHAVEN', 'WINTER HAVEN', 'SALTON CITY',
                   'BOMBAY BEACH', 'PLASTER CITY', 'GLAMIS', 'PALO VERDE'}
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


def norm_tr(v, dirs):
    v = (v or '').strip().upper()
    if len(v) < 2 or v[-1] not in dirs or not v[:-1].isdigit():
        return None
    return int(v[:-1]), v[-1]


def section_centroid(twp, rng, sec, cache):
    """Area centroid of a San Bernardino-meridian PLSS section from BLM CadNSDI (cached; 1 s between requests)."""
    t, r = norm_tr(twp, 'NS'), norm_tr(rng, 'EW')
    s = (sec or '').strip()
    if not t or not r or not s.isdigit() or not 1 <= int(s) <= 36:
        return None
    key = 'CA27%03d0%s%03d0%s0SN%02d0' % (t[0], t[1], r[0], r[1], int(s))
    if key not in cache:
        time.sleep(1.0)
        j = get_json(PLSS_URL, {'where': "FRSTDIVID='%s'" % key, 'outFields': 'FRSTDIVID', 'returnGeometry': 'true',
                                'outSR': 4326, 'f': 'json'})
        if j.get('error'):
            raise SystemExit('PLSS error: %s' % j['error'])
        feats = j.get('features') or []
        if len(feats) != 1:
            cache[key] = None
        else:
            A = cx = cy = 0.0
            for ring in feats[0]['geometry']['rings']:
                for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
                    c = x0 * y1 - x1 * y0; A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
            cache[key] = [round(cy / (3 * A), 6), round(cx / (3 * A), 6)] if A else None
    return cache[key]


def fetch_extra():
    path = os.path.join(STATE, 'extra_wcr_other_county.json')
    if not os.path.exists(path):
        where = 'WCRNumber IN (%s)' % ','.join("'%s'" % w for w in EXTRA_WCRS)
        j = get_json(QUERY, {'where': where, 'outFields': '*', 'returnGeometry': 'false', 'f': 'json'})
        if j.get('error'):
            raise SystemExit('ArcGIS error: %s' % j['error'])
        json.dump(j, open(path, 'w'))
    return [f['attributes'] for f in json.load(open(path))['features']]


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
    extra = [a for a in fetch_extra() if a['WCRNumber'] not in {x['WCRNumber'] for x in recs}]
    cpath = os.path.join(STATE, 'plss_sections_sbbm.json')
    cache = json.load(open(cpath)) if os.path.exists(cpath) else {}
    added = []
    for a in sel + extra:
        r = slim(a)
        if a in extra:
            r['xc'] = a.get('CountyName') or '(blank)'
            added.append(r['wcr'])
        lat, lon = a.get('DecimalLatitude'), a.get('DecimalLongitude')
        bad = None
        if lat is None or lon is None:
            bad = 'no coordinates in DWR index'
        elif not in_box(lat, lon, PLACE_BOX):
            bad = 'DWR coordinates far outside Imperial County'
        if bad:
            mer = (a.get('BaselineMeridian') or '').strip().lower()
            # DWR rows keyed 'Mount Diablo' whose city is an Imperial town: the meridian label is the error (MDM T13-17S
            # R9-16E lies in Fresno, which is exactly where DWR's bad lat/lon landed), so read the TRS as SBBM.
            mdm_fix = mer == 'mount diablo' and (a.get('City') or '').strip().upper() in IMPERIAL_CITIES
            c = section_centroid(a.get('Township'), a.get('Range'), a.get('Section'), cache) if (mer in ('', 'san bernardino', 's') or mdm_fix) else None
            if c and inside(c[1], c[0], rings):
                if lat is not None:
                    r['slat'], r['slon'] = lat, lon
                    r['rep'] = 1
                r['lat'], r['lon'] = c
                r['acc'] = TRS_ACC
                r['llm'] = 'Wells Nearby: BLM CadNSDI section centroid from DWR TRS (SBBM)'
                r['trs'] = 1
                if mdm_fix:
                    r['mer'] = 1
                r['dat'] = 'WGS84'
                lat, lon = c
            else:
                why = bad
                if not c and (a.get('Section') or '').strip():
                    why += '; TRS section not found in BLM PLSS (SBBM)' if norm_tr(a.get('Township'), 'NS') else '; TRS unusable'
                elif c:
                    why += '; TRS section centroid falls outside Imperial County'
                else:
                    why += '; no section number (TRS incomplete), no APN, no address'
                u = {'wcr': r['wcr'], 'why': why, **{k: r[k] for k in ('twp', 'rng', 'sec', 'city', 'pdf') if k in r}}
                if lat is not None:
                    u['lat'], u['lon'] = lat, lon
                unplaced.append(u)
                continue
        if is_ocotillo(a) or (r.get('trs') and in_box(lat, lon, OCOTILLO_BOX)):
            r['p1'] = 1
        if not inside(lon, lat, rings):
            r['oc'] = 1
        tiles.setdefault(tile_key(lat, lon), {})[r['wcr']] = r
    json.dump(cache, open(cpath, 'w'))

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
        'withPdf': sum(1 for r in placed if r.get('pdf')), 'centroid': sum(1 for r in placed if (r.get('acc') or '').startswith('Centroid of Section')),
        'trsPlaced': sum(1 for r in placed if r.get('trs')), 'coordsReplaced': sum(1 for r in placed if r.get('rep')),
        'addedOtherCounty': sorted(added),
        'outsideCountyLine': sum(1 for r in placed if r.get('oc')),
        'tileDeg': TILE_DEG, 'boundsOrder': 'south,west,north,east',
        'fields': {key: src for src, key in FIELDS} | {'p1': 'in Ocotillo/Coyote Wells/Plaster City phase-1 corridor',
                                                       'oc': 'DWR coordinates fall outside the Imperial County line',
                                                       'trs': 'pin placed by Wells Nearby at the BLM PLSS section centroid from DWR TRS',
                                                       'rep': 'DWR lat/lon was far outside Imperial County and was replaced by the TRS section centroid',
                                                       'mer': 'DWR meridian said Mount Diablo but the city is in Imperial; TRS read as San Bernardino meridian',
                                                       'slat': 'original DWR latitude (replaced)', 'slon': 'original DWR longitude (replaced)',
                                                       'xc': 'DWR filed this record under another county name; coordinates, TRS and city place it in Imperial'},
        'tiles': man, 'unplaced': sorted(unplaced, key=lambda u: u['wcr']),
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
    log(json.dumps({k: manifest[k] for k in ('phase', 'sourceTotal', 'selected', 'count', 'withPdf', 'centroid', 'outsideCountyLine', 'trsPlaced', 'coordsReplaced', 'addedOtherCounty')}),
        'tiles', len(man), 'unplaced', len(unplaced))


if __name__ == '__main__':
    main()
