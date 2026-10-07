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
  python3 tools/extract_la_wcr.py count --bbox=-118.05,33.95,-117.85,34.20      # returnCountOnly (planning)
"""
import argparse, datetime, hashlib, json, math, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'la-wcr')
LOCK = os.path.join('/tmp', 'wells-la-wcr-extract.lock')
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


def get(params):
    wait = _last[0] + GAP_S - time.time()
    if wait > 0:
        time.sleep(wait)
    url = QUERY + '?' + urllib.parse.urlencode(params)
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


def cmd_pull(args):
    bbox = [float(x) for x in args.bbox.split(',')]
    if os.path.exists(LOCK):
        sys.exit(f'another LA extract holds {LOCK}; only one LA extract at a time')
    open(LOCK, 'w').write(str(os.getpid()))
    try:
        n_server = count(bbox)
        print(f'chunk {args.chunk}: server count {n_server}')
        recs = pull(bbox)
    finally:
        os.remove(LOCK)
    recs = [clean(a) for a in recs if (a.get('CountyName') or '').strip() == 'Los Angeles']
    os.makedirs(os.path.join(OUT, 'tiles'), exist_ok=True)
    man = load_json(os.path.join(OUT, 'manifest.json'), {})
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
    chunk = {'id': args.chunk, 'name': args.name or args.chunk, 'bbox': bbox, 'bboxOrder': 'west,south,east,north',
             'pulled': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'serverCount': n_server,
             'count': len(recs), 'withCoords': sum(1 for a in recs if a.get('DecimalLatitude') is not None),
             'withWcrLinks': has('WCRLinks'), 'withAddress': has('WellLocation'), 'withApn': has('APN'),
             'withPermit': has('PermitNumber'), 'tiles': sorted(by_tile)}
    chunks = [c for c in man.get('chunks', []) if c['id'] != args.chunk] + [chunk]
    man.update({'version': 1, 'county': 'los-angeles', 'source': 'CA DWR OSWCR (state well completion reports)',
                'queryUrl': QUERY, 'where': WHERE, 'tileDeg': TILE, 'boundsOrder': 'south,west,north,east',
                'center': CENTER, 'generated': chunk['pulled'], 'chunks': chunks, 'tiles': dict(sorted(tiles.items())),
                'count': sum(t['n'] for t in tiles.values()),
                'note': 'LA County has no public well-permit GIS and no county WCR PDFs; state OSWCR only. WCRLinks are Box viewer pages.'})
    write_json(os.path.join(OUT, 'manifest.json'), man)
    print(json.dumps({k: v for k, v in chunk.items() if k != 'tiles'}, indent=1), f'tiles={len(by_tile)}')


def cmd_count(args):
    bbox = [float(x) for x in args.bbox.split(',')]
    print(args.bbox, count(bbox))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('pull'); p.add_argument('--chunk', required=True); p.add_argument('--name'); p.add_argument('--bbox', required=True)
    p.set_defaults(fn=cmd_pull)
    c = sub.add_parser('count'); c.add_argument('--bbox', required=True); c.set_defaults(fn=cmd_count)
    a = ap.parse_args()
    a.fn(a)
