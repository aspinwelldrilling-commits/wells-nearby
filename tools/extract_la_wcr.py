#!/usr/bin/env python3
"""Los Angeles County wells: cache state DWR OSWCR well completion reports into data/la-wcr/ (LA only).

LA County publishes no public well-permit GIS layer and no county WCR PDF path, so this layer is
state OSWCR only (CountyName='Los Angeles'). Records are kept with their original OSWCR field names
(so js/data.js normalize() works on them unchanged), sharded on a 0.025 deg grid like data/riverside-wcr.
WCRLinks are Box viewer pages: linked, never downloaded.

Never touches data/county-wcr (San Diego) or data/riverside-wcr.

Polite: one request at a time, >= 1.6 s between requests, pages of 1000 by resultOffset. A lock file
keeps a single LA extract running at a time.

  python3 tools/extract_la_wcr.py pull --chunk pomona --name "Pomona Valley / ..." --bbox=-117.85,33.98,-117.65,34.18
  python3 tools/extract_la_wcr.py pull --chunk fringe --bbox=W,S,E,N --bbox=W,S,E,N   # several boxes = one chunk
  python3 tools/extract_la_wcr.py count --bbox=-118.05,33.95,-117.85,34.20      # returnCountOnly (planning)
  python3 tools/extract_la_wcr.py override --wcr WCR2026-001855 --reason "..."  # include-by-WCR-number (wrong CountyName)

Overrides: manifest "overrides" lists WCRs whose OSWCR CountyName is not 'Los Angeles' but whose coordinates are in
LA County. They stay "pending" until a pulled chunk's bbox contains their coordinates; that pull fetches them by
WCRNumber (one query each) and adds them to the tiles with an "_laOverride" note (their CountyName is left as DWR has it).
"""
import argparse, datetime, hashlib, json, math, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'la-wcr')
LOCK = os.path.join('/tmp', 'wells-la-wcr-extract.lock')
LA_PARCELS = 'https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query'
QUERY = ('https://utility.arcgis.com/usrsvcs/servers/c074ca40fd684e41babd776eebefd009/rest/services/'
         'Environment/i07_WellCompletionReports/MapServer/0/query')
WHERE = "CountyName='Los Angeles'"
TILE = 0.025
PAGE = 1000
GAP_S = 1.6
CENTER = [34.055, -117.75]   # spiral center (Pomona)
# same fields the app's state source maps (js/config.js sources.arcgis.fieldMap) + ids/county
FIELDS = ['OBJECTID', 'WCRNumber', 'LegacyLogNumber', 'CountyName', 'DecimalLatitude', 'DecimalLongitude', 'LLAccuracy',
          'MethodofDeterminationLL', 'TotalCompletedDepth', 'TotalDrillDepth', 'DrillingMethod', 'Fluid', 'WellYield',
          'WellYieldUnitofMeasure', 'StaticWaterLevel', 'DateWorkEnded', 'PlannedUseFormerUse', 'B118WellUse', 'RecordType',
          'CasingDiameter', 'TopOfPerforatedInterval', 'BottomofPerforatedInterval', 'DrillerName', 'WellLocation', 'City',
          'APN', 'PermitNumber', 'PermitDate', 'WCRLinks']

_last = [0.0]


def get(params, url_base=QUERY):
    wait = _last[0] + GAP_S - time.time()
    if wait > 0:
        time.sleep(wait)
    url = url_base + '?' + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'wells-nearby-la-wcr/1 (aspinwelldrilling-commits)'})
            with urllib.request.urlopen(req, timeout=90) as r:
                j = json.load(r)
            _last[0] = time.time()
            if 'error' in j:
                raise RuntimeError(j['error'])
            return j
        except Exception as e:  # back off politely, then retry
            _last[0] = time.time()
            print(f'  request failed ({e}); retry {attempt + 1}/3 after backoff', file=sys.stderr)
            time.sleep(GAP_S * (4 ** (attempt + 1)))
    raise RuntimeError('query failed after retries')


def base(bbox):
    w, s, e, n = bbox
    return {'where': WHERE, 'geometry': f'{w},{s},{e},{n}', 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
            'spatialRel': 'esriSpatialRelIntersects', 'f': 'json'}


def count(bbox):
    return get({**base(bbox), 'returnCountOnly': 'true'})['count']


def pull(bbox):
    out, offset = [], 0
    while True:
        j = get({**base(bbox), 'outFields': ','.join(FIELDS), 'returnGeometry': 'true', 'outSR': '4326',
                 'orderByFields': 'OBJECTID', 'resultOffset': str(offset), 'resultRecordCount': str(PAGE)})
        feats = j.get('features') or []
        for f in feats:
            a = f['attributes']
            g = f.get('geometry') or {}
            if a.get('DecimalLatitude') is None and 'y' in g:
                a['DecimalLatitude'], a['DecimalLongitude'] = round(g['y'], 6), round(g['x'], 6)
            out.append(a)
        print(f'  page offset {offset}: {len(feats)} records')
        if not feats or not j.get('exceededTransferLimit'):
            break
        offset += len(feats)
    return out


def tile_key(lat, lon):
    return f'{math.floor(lat / TILE + 1e-9)}_{math.floor(lon / TILE + 1e-9)}'


def tile_bounds(key):
    i, j = map(int, key.split('_'))
    return [round(i * TILE, 6), round(j * TILE, 6), round((i + 1) * TILE, 6), round((j + 1) * TILE, 6)]


def clean(a):
    return {k: (v.strip() if isinstance(v, str) else v) for k, v in a.items()
            if v is not None and not (isinstance(v, str) and not v.strip())}


def load_json(p, default):
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(p, obj):
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, separators=(',', ':'), sort_keys=True)
    os.replace(tmp, p)


def inside(lat, lon, b):
    w, s_, e, n = b
    return lat is not None and lon is not None and w <= lon <= e and s_ <= lat <= n


def by_wcr(wcr):
    j = get({'where': f"WCRNumber='{wcr}'", 'outFields': ','.join(FIELDS), 'returnGeometry': 'true', 'outSR': '4326', 'f': 'json'})
    return [f['attributes'] for f in j.get('features') or []]


def cmd_pull(args):
    boxes = [[float(x) for x in b.split(',')] for b in args.bbox]
    if os.path.exists(LOCK):
        sys.exit(f'another LA extract holds {LOCK}; only one LA extract at a time')
    open(LOCK, 'w').write(str(os.getpid()))
    man = load_json(os.path.join(OUT, 'manifest.json'), {})
    extra = []
    try:
        n_server, recs = 0, []
        for b in boxes:
            c = count(b)
            n_server += c
            print(f'chunk {args.chunk} box {b}: server count {c}')
            recs += pull(b)
        for o in man.get('overrides', []):
            if o.get('status') == 'pending' and any(inside(o.get('lat'), o.get('lon'), b) for b in boxes):
                got = [clean(a) for a in by_wcr(o['wcr'])]
                for a in got:
                    a['_laOverride'] = (f"OSWCR CountyName is '{a.get('CountyName')}', but the coordinates are in Los Angeles "
                                        f"County; included by WCR number ({o.get('reason', '')})").strip()
                extra += got
                o.update({'status': 'included' if got else 'not_found', 'includedIn': args.chunk,
                          'includedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds')})
                print(f"  override {o['wcr']}: {len(got)} record(s)")
    finally:
        os.remove(LOCK)
    seen = set()
    recs = [a for a in recs if not (a['OBJECTID'] in seen or seen.add(a['OBJECTID']))]
    recs = [clean(a) for a in recs if (a.get('CountyName') or '').strip() == 'Los Angeles']
    recs += [a for a in extra if a['OBJECTID'] not in seen]
    os.makedirs(os.path.join(OUT, 'tiles'), exist_ok=True)
    by_tile = {}
    for a in recs:
        if a.get('DecimalLatitude') is None or a.get('DecimalLongitude') is None:
            continue
        by_tile.setdefault(tile_key(a['DecimalLatitude'], a['DecimalLongitude']), []).append(a)
    tiles = man.get('tiles', {})
    for key, rs in by_tile.items():
        p = os.path.join(OUT, 'tiles', key + '.json')
        old = {r['OBJECTID']: r for r in load_json(p, {}).get('records', [])}
        for r in rs:
            old[r['OBJECTID']] = r
        merged = sorted(old.values(), key=lambda r: r['OBJECTID'])
        obj = {'tile': key, 'bounds': tile_bounds(key), 'county': 'los-angeles', 'source': 'DWR OSWCR', 'records': merged}
        write_json(p, obj)
        h = hashlib.sha1(open(p, 'rb').read()).hexdigest()[:10]
        tiles[key] = {'b': tile_bounds(key), 'n': len(merged), 'h': h}
    has = lambda k: sum(1 for a in recs if a.get(k))
    chunk = {'id': args.chunk, 'name': args.name or args.chunk, **({'bbox': boxes[0]} if len(boxes) == 1 else {'bboxes': boxes}),
             'bboxOrder': 'west,south,east,north',
             'pulled': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'serverCount': n_server,
             'count': len(recs), 'withCoords': sum(1 for a in recs if a.get('DecimalLatitude') is not None),
             'withWcrLinks': has('WCRLinks'), 'withAddress': has('WellLocation'), 'withApn': has('APN'),
             'withPermit': has('PermitNumber'), 'overridesIncluded': [a['WCRNumber'] for a in extra], 'tiles': sorted(by_tile)}
    chunks = [c for c in man.get('chunks', []) if c['id'] != args.chunk] + [chunk]
    man.update({'version': 1, 'county': 'los-angeles', 'source': 'CA DWR OSWCR (state well completion reports)',
                'queryUrl': QUERY, 'where': WHERE, 'tileDeg': TILE, 'boundsOrder': 'south,west,north,east',
                'center': CENTER, 'generated': chunk['pulled'], 'chunks': chunks, 'tiles': dict(sorted(tiles.items())),
                'count': sum(t['n'] for t in tiles.values()),
                'note': 'LA County has no public well-permit GIS and no county WCR PDFs; state OSWCR only. WCRLinks are Box viewer pages.'})
    write_json(os.path.join(OUT, 'manifest.json'), man)
    print(json.dumps({k: v for k, v in chunk.items() if k != 'tiles'}, indent=1), f'tiles={len(by_tile)}')


def cmd_count(args):
    for b in args.bbox:
        print(b, count([float(x) for x in b.split(',')]))


def cmd_override(args):
    """Record an include-by-WCR-number override (one OSWCR query + one LA parcel point check). Pulled later by the chunk
    whose bbox contains it."""
    got = by_wcr(args.wcr)
    if args.save_raw:
        with open(args.save_raw, 'w') as f:
            json.dump(got, f, indent=1)
    if len(got) != 1:
        sys.exit(f'{args.wcr}: expected 1 OSWCR record, got {len(got)}')
    a = clean(got[0])
    lat, lon = a.get('DecimalLatitude'), a.get('DecimalLongitude')
    parcel = None
    if lat is not None:
        j = get({'geometry': f'{lon},{lat}', 'geometryType': 'esriGeometryPoint', 'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects',
                 'outFields': 'AIN,SitusCity', 'returnGeometry': 'false', 'f': 'json'}, LA_PARCELS)
        feats = j.get('features') or []
        parcel = feats[0]['attributes'] if feats else None
    man = load_json(os.path.join(OUT, 'manifest.json'), {})
    entry = {'wcr': args.wcr, 'objectId': a.get('OBJECTID'), 'oswcrCountyName': a.get('CountyName'), 'lat': lat, 'lon': lon,
             'llAccuracy': a.get('LLAccuracy'), 'llMethod': a.get('MethodofDeterminationLL'), 'wellLocation': a.get('WellLocation'),
             'city': a.get('City'), 'wcrLinks': a.get('WCRLinks'),
             'laCountyCheck': ({'inLaCountyParcel': True, 'source': 'LA County public parcels MapServer (point-in-parcel)', **parcel}
                               if parcel else {'inLaCountyParcel': False, 'source': 'LA County public parcels MapServer (no parcel at point)'}),
             'reason': args.reason, 'status': 'pending', 'includeWhen': 'a pulled LA chunk bbox contains lat/lon',
             'addedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds')}
    man['overrides'] = [o for o in man.get('overrides', []) if o['wcr'] != args.wcr] + [entry]
    write_json(os.path.join(OUT, 'manifest.json'), man)
    print(json.dumps(entry, indent=1))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pull'); p.add_argument('--chunk', required=True); p.add_argument('--name')
    p.add_argument('--bbox', required=True, action='append', help='W,S,E,N (repeat for a multi-box chunk)')
    p.set_defaults(fn=cmd_pull)
    c = sub.add_parser('count'); c.add_argument('--bbox', required=True, action='append'); c.set_defaults(fn=cmd_count)
    o = sub.add_parser('override'); o.add_argument('--wcr', required=True); o.add_argument('--reason', default='')
    o.add_argument('--save-raw'); o.set_defaults(fn=cmd_override)
    a = ap.parse_args()
    a.fn(a)
