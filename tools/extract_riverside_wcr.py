#!/usr/bin/env python3
"""Extract well data from Riverside County DEH Well Completion Reports (WCRs).

Unlike San Diego (DEH library + OutSystems viewer), Riverside FeatureServer rows often
carry a direct OpenDoc PDF URL in WCR_Path. This tool:

  1. lists RivCo_Well_Permits (FeatureServer/2) in a bbox / radius / permit list,
  2. downloads each WCR_Path PDF (polite delay ≥ 2.5s between county requests),
  3. reuses the SD OCR + field regex (tools/extract_county_wcr.py) without modifying it,
  4. writes data/riverside-wcr/<WellPCID>.json + tiles/ + manifest.json
     (separate from data/county-wcr so SD caches never clash).

Do NOT bump SD SCRIPT_VERSION from here. SD extractor behavior is unchanged.

Usage:
  python3 tools/extract_riverside_wcr.py --bbox -117.05,33.35,-116.70,33.55 --area aguanga
  python3 tools/extract_riverside_wcr.py --lat 33.4425 --lon -116.8642 --radius 12 --area aguanga
  python3 tools/extract_riverside_wcr.py --permits WP0030620,WP1000236 --force
  python3 tools/extract_riverside_wcr.py --rebuild-index
"""
from __future__ import annotations

import argparse, datetime as dt, glob, hashlib, json, math, os, re, shutil, sys, tempfile, threading, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import extract_county_wcr as sd  # reuse OCR/parse; do not modify that file

OUT = os.path.join(ROOT, 'data', 'riverside-wcr')
PAGE_CACHE = os.path.join(ROOT, '.cache', 'riverside-wcr-pages')
PDF_CACHE = os.path.join(ROOT, '.cache', 'riverside-wcr-pdfs')
TILES = os.path.join(OUT, 'tiles')
COUNTY_LAYER = 'https://services1.arcgis.com/pWmBUdSlVpXStHU6/arcgis/rest/services/RivCo_Well_Permits/FeatureServer/2/query'
UA = 'WellsNearby-riverside/1.0 (small-business field tool; low-rate; +2.5s polite delay)'
SCRIPT_VERSION = 1  # RivCo-only version; independent of SD SCRIPT_VERSION
WORKERS_CAP = 3
TILE_DEG = 0.025
MAX_DOC_BYTES = 25_000_000

# Wider than SD — Aguanga/Sage sit near the SD north edge; full RivCo is further north.
sd.LAT_RANGE = (33.20, 34.20)
sd.LON_RANGE = (-117.80, -116.00)


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def http_json(url, timeout=90):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def http_bytes(url, timeout=120):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/pdf,*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get('Content-Type', '')


def hav(a, b, c, d):
    r = math.radians
    x = math.sin(r(c - a) / 2) ** 2 + math.cos(r(a)) * math.cos(r(c)) * math.sin(r(d - b) / 2) ** 2
    return 3958.7613 * 2 * math.asin(math.sqrt(x))


def riv_permits_bbox(west, south, east, north, where_extra="WCR_Path IS NOT NULL AND WCR_Path <> ''"):
    """Paginate FeatureServer/2 in an envelope. Returns list of attribute dicts with _lat/_lon."""
    out, offset = [], 0
    where = where_extra or '1=1'
    while True:
        q = urllib.parse.urlencode({
            'where': where,
            'geometry': f'{west},{south},{east},{north}',
            'geometryType': 'esriGeometryEnvelope', 'inSR': 4326,
            'spatialRel': 'esriSpatialRelIntersects',
            'outFields': 'WellPCID,Legacy_Permit,APN,Well_Address,City,Zip_Code,Type_of_Well,Service_Type,'
                         'Latitude,Longitude,Application_Status,Submitted_Date,Final_Approval_Date,'
                         'WCR_Path,Permit_Path,Accuracy,Source',
            'returnGeometry': 'true', 'outSR': 4326,
            'orderByFields': 'OBJECTID', 'resultOffset': offset, 'resultRecordCount': 2000, 'f': 'json',
        })
        j = http_json(COUNTY_LAYER + '?' + q)
        feats = []
        for f in j.get('features', []):
            a = dict(f['attributes'])
            g = f.get('geometry') or {}
            a['_lat'] = a.get('Latitude') if a.get('Latitude') is not None else g.get('y')
            a['_lon'] = a.get('Longitude') if a.get('Longitude') is not None else g.get('x')
            feats.append(a)
        out += feats
        if not j.get('exceededTransferLimit') or not feats:
            return out
        offset += len(feats)


def riv_permits_radius(lat, lon, radius, where_extra="WCR_Path IS NOT NULL AND WCR_Path <> ''"):
    dlat = (radius * 1.25) / 69.05
    dlon = (radius * 1.25) / (69.17 * math.cos(math.radians(lat)))
    feats = riv_permits_bbox(lon - dlon, lat - dlat, lon + dlon, lat + dlat, where_extra)
    return [f for f in feats if f.get('_lat') is None or hav(lat, lon, f['_lat'], f['_lon']) <= radius + 0.1]


def riv_permits_ids(ids):
    out = []
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        ids_sql = ','.join("'" + p.replace("'", '') + "'" for p in chunk)
        q = urllib.parse.urlencode({
            'where': f'WellPCID IN ({ids_sql})',
            'outFields': '*', 'returnGeometry': 'true', 'outSR': 4326, 'f': 'json',
        })
        j = http_json(COUNTY_LAYER + '?' + q)
        for f in j.get('features', []):
            a = dict(f['attributes'])
            g = f.get('geometry') or {}
            a['_lat'] = a.get('Latitude') if a.get('Latitude') is not None else g.get('y')
            a['_lon'] = a.get('Longitude') if a.get('Longitude') is not None else g.get('x')
            out.append(a)
        time.sleep(1.0)
    return out


def enrich_riv_fields(fields, text, source, words):
    """Fill gaps left by SD parse_fields for modern RivCo DWR 188 spacing and older drillers reports."""
    N = r'([0-9O][0-9O,]*(?:\.[0-9]+)?)'

    def conf_for(m, g=1):
        if source == 'text':
            return 'high', None
        c = sd.span_conf(words, m.start(g), m.end(g))
        return ('high' if c is not None and c >= 80 else 'medium' if c is not None and c >= 50 else 'low'), c

    def set_num(name, patterns, prefer_first=True):
        if name in fields:
            return
        for p in patterns:
            m = re.search(p, text, re.I)
            if not m:
                continue
            v = sd.clean_num(m.group(1))
            if v is None:
                continue
            lo, hi = sd.BOUNDS[name]
            if not (lo <= v <= hi):
                continue
            lvl, c = conf_for(m)
            fields[name] = {'value': v, 'conf': lvl, 'ocrConf': c, 'raw': m.group(0)[:80]}
            return

    # Modern RivCo text PDFs: "Estimated Yield*             25 (GPM)"
    set_num('gpm', [r'estimated\s+yield[\s*_:.\-]{0,40}' + N + r'\s*\(?\s*gpm'])
    # Older DWR 188 (REV. 12-86): Completed depth / Total depth on WELL LOG line
    if 'depthFt' not in fields:
        m = re.search(r'completed\s+depth\s*' + N + r'\s*(?:ft|feet)?', text, re.I)
        if m:
            v = sd.clean_num(m.group(1))
            if v and sd.BOUNDS['depthFt'][0] <= v <= sd.BOUNDS['depthFt'][1]:
                lvl, c = conf_for(m)
                fields['depthFt'] = {'value': v, 'conf': lvl, 'ocrConf': c, 'raw': m.group(0)[:80]}
        if 'depthFt' not in fields:
            m = re.search(r'(?:\(12\)\s*)?well\s+log[:\s]*total\s+depth\s*' + N + r'|total\s+depth\s*(?:of\s+well)?\s*' + N + r'\s*(?:ft|feet)', text, re.I)
            if m:
                g = 1 if m.group(1) else 2
                v = sd.clean_num(m.group(g))
                if v and sd.BOUNDS['depthFt'][0] <= v <= sd.BOUNDS['depthFt'][1]:
                    lvl, c = conf_for(m, g)
                    fields['depthFt'] = {'value': v, 'conf': {'high': 'medium', 'medium': 'low'}.get(lvl, 'low'),
                                         'ocrConf': c, 'raw': m.group(0)[:80],
                                         'note': 'total depth (completed depth not read)'}
    # Standing level after well completion (old form SWL)
    set_num('swlFt', [
        r'standing\s+level\s+after\s+well\s+completion[\s_]*' + N + r'\s*(?:ft|feet)?',
        r'standing\s+level[\s_]*' + N + r'\s*(?:ft|feet)',
    ])
    # Discharge 200 gal/min (old pump test) — allow OCR underscores/spaces
    set_num('gpm', [
        r'discharge[\s_.:\-]*' + N + r'\s*gal(?:lons)?\s*/?\s*min',
        r'discharge[\s_.:\-]*' + N + r'\s*g\.?p\.?m',
    ])
    # Work completed date on old form ("Completed 9-19-90" / "Completed___9=1@_90")
    if 'dateEnded' not in fields:
        m = re.search(r'completed[\s_:=.\-]*([0-9O]{1,2})\s*[/=.\-]\s*([0-9O]{1,2})\s*[/=.\-]\s*([0-9O]{2,4})', text, re.I)
        if m:
            try:
                mo, d, y = int(sd.clean_num(m.group(1))), int(sd.clean_num(m.group(2))), int(sd.clean_num(m.group(3)))
                if y < 100:
                    y += 1900 if y > 30 else 2000
                date = dt.date(y, mo, d)
                if 1950 <= y <= dt.date.today().year:
                    lvl, c = conf_for(m, 3)
                    fields['dateEnded'] = {'value': date.isoformat(), 'conf': lvl if lvl != 'low' else 'medium', 'ocrConf': c, 'raw': m.group(0)[:80]}
            except Exception:
                pass
    return fields


def read_pdf_riv(path, tmp):
    pages = sd.read_pdf(path, tmp)
    for pg in pages:
        words = pg.get('words') or []
        pg['fields'] = enrich_riv_fields(pg['fields'], pg.get('text') or '', pg['source'], words)
    return pages


def opendoc_id(url):
    m = re.search(r'/OpenDoc/(\d+)', url or '')
    if m:
        return m.group(1)
    m = re.search(r'docid=(\d+)', url or '', re.I)
    return m.group(1) if m else None


def download_wcr(url, delay, last_end):
    """Download OpenDoc PDF. Returns (bytes|None, error|None, new_last_end)."""
    sd._wait_county_gap(last_end, delay)
    try:
        data, ctype = http_bytes(url)
        end = time.time()
        if not data or data[:4] != b'%PDF':
            # Fallback TLMA ElectronicFile
            doc_id = opendoc_id(url)
            if doc_id:
                sd._wait_county_gap(end, delay)
                alt = f'https://weblink.rctlma.org/EH_Weblink/ElectronicFile.aspx?docid={doc_id}&dbid=0'
                data, ctype = http_bytes(alt)
                end = time.time()
        if not data or data[:4] != b'%PDF':
            return None, f'no pdf ({ctype or "empty"})', end
        if len(data) > MAX_DOC_BYTES:
            return None, f'skipped large doc {len(data)} bytes', end
        return data, None, end
    except Exception as e:
        return None, f'download: {e}', time.time()


def preflight():
    missing = [t for t in sd.REQUIRED_TOOLS if not shutil.which(t)]
    if not missing:
        langs = sd.run(['tesseract', '--list-langs'], timeout=30)
        if 'eng' not in (langs.stdout + langs.stderr).split():
            missing.append('tesseract language data "eng"')
    if missing:
        log('PREFLIGHT FAILED — missing: ' + ', '.join(missing))
        sys.exit(4)


def load_rec(permit):
    try:
        return json.load(open(os.path.join(OUT, permit + '.json')))
    except Exception:
        return None


def slim(r):
    f = {}
    for k, v in (r.get('fields') or {}).items():
        if k == 'activity':
            f[k] = v
        elif k == 'gps':
            f[k] = {'lat': v['lat'], 'lon': v['lon'], 'conf': v['conf']}
        elif isinstance(v, dict):
            f[k] = {'value': v.get('value'), 'conf': v.get('conf')}
    e = {'status': r.get('status'), 'fields': f, 'bestDocUrl': r.get('bestDocUrl')}
    if r.get('bestDocPage'):
        e['bestDocPage'] = r['bestDocPage']
    return e


def tile_key(lat, lon):
    return f'{math.floor(lat / TILE_DEG + 1e-9)}_{math.floor(lon / TILE_DEG + 1e-9)}'


def tile_bounds(key):
    iy, ix = (int(x) for x in key.split('_'))
    return [round(iy * TILE_DEG, 6), round(ix * TILE_DEG, 6), round((iy + 1) * TILE_DEG, 6), round((ix + 1) * TILE_DEG, 6)]


def rebuild_index():
    recs = {}
    for f in sorted(glob.glob(os.path.join(OUT, 'WP*.json'))):
        r = json.load(open(f))
        recs[r['permit']] = r
    tiles, unplaced = {}, []
    for p, r in recs.items():
        if r.get('lat') is None:
            unplaced.append(p)
            continue
        tiles.setdefault(tile_key(r['lat'], r['lon']), {})[p] = slim(r)
    os.makedirs(TILES, exist_ok=True)
    man = {}
    for k in sorted(tiles):
        body = json.dumps(tiles[k], sort_keys=True, separators=(',', ':'))
        h = hashlib.sha1(body.encode()).hexdigest()[:10]
        path = os.path.join(TILES, k + '.json')
        text = '{"tile":"%s","bounds":%s,"permits":%s}' % (k, json.dumps(tile_bounds(k), separators=(',', ':')), body)
        if not os.path.exists(path) or open(path).read() != text:
            open(path, 'w').write(text)
        man[k] = {'b': tile_bounds(k), 'n': len(tiles[k]), 'h': h}
    for path in glob.glob(os.path.join(TILES, '*.json')):
        if os.path.basename(path)[:-5] not in man:
            os.remove(path)
    if unplaced:
        log(f'{len(unplaced)} permits without coords (not in any tile): {",".join(unplaced[:10])}')
    now = dt.datetime.now().astimezone().isoformat(timespec='seconds')
    json.dump({'version': 1, 'generated': now, 'tileDeg': TILE_DEG, 'count': sum(m['n'] for m in man.values()),
               'boundsOrder': 'south,west,north,east', 'county': 'riverside', 'tiles': man},
              open(os.path.join(OUT, 'manifest.json'), 'w'), separators=(',', ':'))
    json.dump({'moved': 'manifest.json (per-tile shards in tiles/)', 'count': 0, 'permits': {}, 'county': 'riverside'},
              open(os.path.join(OUT, 'index.json'), 'w'))
    return len(recs)


def process_one(feat, delay, last_end, tmp, area, force=False):
    permit = (feat.get('WellPCID') or '').strip().upper()
    if not permit:
        return None, last_end, 'skip-no-id'
    existing = load_rec(permit)
    if existing and not force and existing.get('version') == SCRIPT_VERSION and existing.get('status') != 'error':
        return existing, last_end, 'cached'

    wcr_url = (feat.get('WCR_Path') or '').strip()
    rec = {
        'permit': permit,
        'processed': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        'version': SCRIPT_VERSION,
        'county': 'riverside',
        'apn': feat.get('APN'),
        'address': feat.get('Well_Address'),
        'city': feat.get('City'),
        'docs': [],
        'wcrPages': [],
        'fields': {},
        'bestDocUrl': wcr_url or None,
        'errors': [],
        'area': area or '',
        'lat': feat.get('_lat'),
        'lon': feat.get('_lon'),
        'permitPath': feat.get('Permit_Path'),
        'wcrPath': wcr_url,
        'serviceType': feat.get('Service_Type'),
        'wellType': feat.get('Type_of_Well'),
        'statusCounty': feat.get('Application_Status'),
    }

    if not wcr_url:
        rec['status'] = 'no_docs'
        return rec, last_end, 'no_wcr_path'

    # PDF cache by OpenDoc id (local only)
    os.makedirs(PDF_CACHE, exist_ok=True)
    doc_id = opendoc_id(wcr_url) or hashlib.sha1(wcr_url.encode()).hexdigest()[:12]
    pdf_path = os.path.join(PDF_CACHE, f'{doc_id}.pdf')
    data = None
    if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 100:
        data = open(pdf_path, 'rb').read()
        if data[:4] != b'%PDF':
            data = None

    if data is None:
        data, err, last_end = download_wcr(wcr_url, delay, last_end)
        if err:
            rec['errors'].append(err)
            rec['status'] = 'error' if err.startswith('download') or err.startswith('no pdf') else 'no_wcr'
            if 'large' in err:
                rec['status'] = 'error'
            return rec, last_end, 'fetch-fail'
        open(pdf_path, 'wb').write(data)

    rec['docs'] = [{'url': wcr_url, 'desc': 'WCR_Path OpenDoc', 'subtype': 'Well Completion Report',
                    'scanned': '', 'kb': round(len(data) / 1024)}]

    work_pdf = os.path.join(tmp, f'{permit}.pdf')
    open(work_pdf, 'wb').write(data)
    try:
        pages = read_pdf_riv(work_pdf, tmp)
    except Exception as e:
        rec['errors'].append(f'read: {e}')
        rec['status'] = 'error'
        return rec, last_end, 'read-fail'
    finally:
        for fn in glob.glob(os.path.join(tmp, 'p*.png')):
            try:
                os.remove(fn)
            except OSError:
                pass
        try:
            os.remove(work_pdf)
        except OSError:
            pass

    for pg in pages:
        pg['url'] = wcr_url
    rec['wcrPages'] = [{'url': wcr_url, 'page': pg['page'], 'source': pg['source'],
                        'nFields': len([k for k in pg['fields'] if k in sd.KEY_FIELDS])} for pg in pages]
    os.makedirs(PAGE_CACHE, exist_ok=True)
    json.dump([{k: pg[k] for k in ('url', 'page', 'source', 'text', 'words') if k in pg} for pg in pages],
              open(os.path.join(PAGE_CACHE, permit + '.json'), 'w'))
    sd.finalize(rec, pages)
    return rec, last_end, rec['status']


def worker_loop(feats, delay, area, force, stats, lock, counter):
    last_end = None
    with tempfile.TemporaryDirectory(prefix='riv-wcr-') as tmp:
        for feat in feats:
            t0 = time.time()
            rec, last_end, tag = process_one(feat, delay, last_end, tmp, area, force=force)
            if rec is None:
                continue
            path = os.path.join(OUT, rec['permit'] + '.json')
            if tag != 'cached':
                json.dump(rec, open(path, 'w'), indent=1)
            with lock:
                counter[0] += 1
                i = counter[0]
                stats[tag if tag in stats else 'other'] = stats.get(tag if tag in stats else 'other', 0) + 1
                st = rec.get('status') or tag
                stats['status:' + st] = stats.get('status:' + st, 0) + 1
                n = counter[1]
                log(f'[{i}/{n}] {rec["permit"]} {st} ({time.time() - t0:.1f}s) {feat.get("Well_Address") or ""}')
                if i % 25 == 0:
                    rebuild_index()
                    log(f'  checkpoint index: {json.load(open(os.path.join(OUT, "manifest.json"))).get("count")} permits')


def main():
    ap = argparse.ArgumentParser(description='Riverside County WCR extractor (OpenDoc PDFs)')
    ap.add_argument('--bbox', help='west,south,east,north (use --bbox=-117.05,33.35,-116.70,33.55 — leading minus needs =)')
    ap.add_argument('--lat', type=float)
    ap.add_argument('--lon', type=float)
    ap.add_argument('--radius', type=float, default=0)
    ap.add_argument('--permits', help='comma-separated WellPCID list')
    ap.add_argument('--area', default='')
    ap.add_argument('--delay', type=float, default=2.5)
    ap.add_argument('--workers', type=int, default=1)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--all-permits', action='store_true', help='include permits without WCR_Path')
    ap.add_argument('--rebuild-index', action='store_true')
    ap.add_argument('--reparse', action='store_true', help='re-run field parse on cached page text (no network)')
    ap.add_argument('--list-only', action='store_true')
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TILES, exist_ok=True)

    if args.rebuild_index:
        n = rebuild_index()
        log(f'rebuilt riverside index: {n} permits')
        return

    if args.reparse:
        n = 0
        for f in sorted(glob.glob(os.path.join(OUT, 'WP*.json'))):
            rec = json.load(open(f))
            cp = os.path.join(PAGE_CACHE, rec['permit'] + '.json')
            if not os.path.exists(cp):
                continue
            pages = json.load(open(cp))
            for pg in pages:
                words = [tuple(w) for w in (pg.get('words') or [])]
                pg['fields'] = sd.parse_fields(pg.get('text') or '', words, pg.get('source') or 'ocr')
                pg['fields'] = enrich_riv_fields(pg['fields'], pg.get('text') or '', pg.get('source') or 'ocr', words)
            rec['wcrPages'] = [{'url': pg.get('url'), 'page': pg['page'], 'source': pg['source'],
                                'nFields': len([k for k in pg['fields'] if k in sd.KEY_FIELDS])} for pg in pages]
            sd.finalize(rec, pages)
            json.dump(rec, open(f, 'w'), indent=1)
            n += 1
        log(f'reparsed {n} permits; index has {rebuild_index()}')
        return

    preflight()
    where = '1=1' if args.all_permits else "WCR_Path IS NOT NULL AND WCR_Path <> ''"

    if args.permits:
        ids = [x.strip().upper() for x in args.permits.split(',') if x.strip()]
        feats = riv_permits_ids(ids)
    elif args.bbox:
        w, s, e, n = (float(x) for x in args.bbox.split(','))
        feats = riv_permits_bbox(w, s, e, n, where)
    elif args.lat is not None and args.lon is not None and args.radius > 0:
        feats = riv_permits_radius(args.lat, args.lon, args.radius, where)
    else:
        ap.error('need --bbox or --lat/--lon/--radius or --permits')

    # Prefer Individual/Ag construction first, then the rest
    def rank(f):
        t = (f.get('Type_of_Well') or '')
        svc = (f.get('Service_Type') or '')
        pri = 0 if re.search(r'Individual|Agricultur', t, re.I) and not re.search(r'destr|monitor', t + svc, re.I) else 1
        return (pri, f.get('WellPCID') or '')

    feats = sorted(feats, key=rank)
    if args.limit:
        feats = feats[:args.limit]

    log(f'{len(feats)} RivCo permits to process (area={args.area or "-"}, delay={args.delay}s, workers={args.workers})')
    if args.list_only:
        for f in feats:
            print(f.get('WellPCID'), f.get('APN'), f.get('Well_Address'), f.get('WCR_Path'))
        return

    # Skip already-good unless --force
    todo = []
    for f in feats:
        p = (f.get('WellPCID') or '').strip().upper()
        ex = load_rec(p)
        if ex and not args.force and ex.get('version') == SCRIPT_VERSION and ex.get('status') != 'error':
            continue
        todo.append(f)
    log(f'{len(todo)} need work ({len(feats) - len(todo)} already cached)')

    workers = max(1, min(int(args.workers), WORKERS_CAP))
    if workers > 1 and args.delay < 2.5:
        log(f'raising delay to 2.5s (polite floor) for multi-worker run')
        args.delay = 2.5

    stats = {}
    lock = threading.Lock()
    counter = [0, len(todo)]

    if not todo:
        n = rebuild_index()
        log(f'nothing to do; index has {n}')
        return

    if workers == 1:
        worker_loop(todo, args.delay, args.area, args.force, stats, lock, counter)
    else:
        # Split round-robin so each worker stays polite on its own timeline
        buckets = [[] for _ in range(workers)]
        for i, f in enumerate(todo):
            buckets[i % workers].append(f)
        threads = []
        for b in buckets:
            if not b:
                continue
            th = threading.Thread(target=worker_loop, args=(b, args.delay, args.area, args.force, stats, lock, counter))
            th.start()
            threads.append(th)
        for th in threads:
            th.join()

    n = rebuild_index()
    log(f'done. index={n} stats={json.dumps(stats, sort_keys=True)}')
    # Progress note for parent
    prog = {
        'updated': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        'area': args.area, 'processed': counter[0], 'todo': len(todo), 'index': n, 'stats': stats,
    }
    os.makedirs('/workspace/wells-state/riverside', exist_ok=True)
    json.dump(prog, open('/workspace/wells-state/riverside/extract-progress.json', 'w'), indent=2)


if __name__ == '__main__':
    main()
