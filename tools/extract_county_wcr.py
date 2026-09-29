#!/usr/bin/env python3
"""Extract well data from San Diego County DEHQ well completion reports (WCRs).

For each county water-well permit in an area:
  1. list its documents in the DEHQ Environmental Health Document Library (JSON search API),
  2. open the most likely documents in the county's public viewer (headless browser) to get the PDF,
  3. find WCR pages and read them:  generated/text PDFs -> pdftotext;  scans -> tesseract (typed forms only;
     handwriting is not readable with tesseract and is reported as 'unreadable'),
  4. parse depth, drilling method/fluid, yield (GPM), static water level, date work ended, decimal lat/lon,
     with per-field confidence (tesseract word confidence) and plausibility checks,
  5. write data/county-wcr/<PERMIT>.json (with the permit's parcel point) and rebuild the shards the app loads:
     data/county-wcr/tiles/<iy>_<ix>.json (fixed 0.025 deg lat/lon grid, ~1.7 x 1.45 mi) + data/county-wcr/manifest.json
     (bounds, count and content hash per tile). The app fetches only the tiles that intersect its search circle.

Polite: one request at a time, --delay seconds (default 2.5) between county requests. Cached permits are skipped
unless --force. Requires: poppler-utils (pdftotext/pdfimages/pdftoppm), tesseract-ocr, playwright + Chrome.

Usage:
  /workspace/.venv-pw/bin/python tools/extract_county_wcr.py --lat 33.0417 --lon -116.8681 --radius 1 --area ramona
  /workspace/.venv-pw/bin/python tools/extract_county_wcr.py --permits DEH2014-LWELL-000720,DEH2016-LWELL-001272
"""
import argparse, base64, datetime as dt, glob, hashlib, json, math, os, re, shutil, signal, subprocess, sys, tempfile, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'county-wcr')
PAGE_CACHE = os.path.join(ROOT, '.cache', 'wcr-pages')   # page text + word confidences (local only, for --reparse)
COUNTY_LAYER = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/100/query'
PARCEL_LAYER = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/0/query'
DOC_API = 'https://file.sandiegocounty.gov/CoSD_LUEG_Repository_External_API/rest/DEHQDocumentLibrary/SearchDocuments'
VIEWER = 'https://file.sandiegocounty.gov/LUEG/LUEG_View?FileRecordId='
UA = 'WellsNearby-extractor/1.0 (small-business field tool; low-rate)'
SCRIPT_VERSION = 5  # 5: letter-spaced county text layers checked in compact form. 4: 1970s-80s "Water Well Drillers Report" forms count as WCR pages. 3: tool/read/viewer failures -> 'error' (not no_wcr); preflight check of OCR tools
MAX_DOCS = 4
MAX_DOC_BYTES = 25_000_000
MAX_OCR_PAGES = 6

BOUNDS = {'depthFt': (20, 3000), 'swlFt': (0.5, 1500), 'gpm': (0.05, 3000)}  # water-supply wells: <20 ft is a misread
LAT_RANGE, LON_RANGE = (32.5, 33.55), (-117.65, -116.05)
METHOD_WORDS = ['air rotary', 'mud rotary', 'direct rotary', 'reverse circulation', 'reverse rotary', 'cable tool', 'cable',
                'auger', 'down hole hammer', 'downhole hammer', 'dth', 'hammer', 'rotary', 'air', 'mud', 'jetted', 'bucket']
FLUID_WORDS = ['air', 'foam', 'mud', 'bentonite', 'polymer', 'water', 'none']


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def http_json(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


# ---------------------------------------------------------------- county permits + documents
def county_permits(lat, lon, radius):
    # The server-side distance buffer doesn't exactly match the app's radius, so query 25% wider and cut back
    # with haversine plus a small margin (processing a few extra edge permits is harmless).
    import math
    def hav(a, b, c, d):
        r = math.radians; x = math.sin(r(c - a) / 2) ** 2 + math.cos(r(a)) * math.cos(r(c)) * math.sin(r(d - b) / 2) ** 2
        return 3958.7613 * 2 * math.asin(math.sqrt(x))
    feats = county_permits_raw(lat, lon, radius * 1.25)
    return [f for f in feats if f.get('_lat') is None or hav(lat, lon, f['_lat'], f['_lon']) <= radius + 0.1]  # +0.1 mi margin: app distances can differ slightly


def corridor_circles(path, buffer):
    """Circles (lat, lon, r) covering a buffer of `buffer` mi around a polyline [(lat, lon), ...], plus a distance fn."""
    def xy(p, lat0): return ((p[1]) * 69.17 * math.cos(math.radians(lat0)), p[0] * 69.05)
    lat0 = sum(p[0] for p in path) / len(path)
    def seg_d(q, a, b):
        (qx, qy), (ax, ay), (bx, by) = xy(q, lat0), xy(a, lat0), xy(b, lat0)
        dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
        t = 0 if L == 0 else max(0, min(1, ((qx - ax) * dx + (qy - ay) * dy) / L))
        return math.hypot(qx - ax - t * dx, qy - ay - t * dy)
    dist = lambda q: min(seg_d(q, path[i], path[i + 1]) for i in range(len(path) - 1)) if len(path) > 1 else seg_d(q, path[0], path[0])
    circles, step = [], buffer
    for i in range(max(1, len(path) - 1)):
        a, b = path[i], path[min(i + 1, len(path) - 1)]
        (ax, ay), (bx, by) = xy(a, lat0), xy(b, lat0)
        n = max(1, math.ceil(math.hypot(bx - ax, by - ay) / step))
        for k in range(n + 1):
            circles.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, buffer * 1.2))
    return circles, dist


def county_permits_where(where):
    q = urllib.parse.urlencode({'where': where, 'outFields': '*', 'returnGeometry': 'true', 'outSR': 4326, 'f': 'json'})
    j = http_json(COUNTY_LAYER + '?' + q)
    return [dict(f['attributes'], _lat=(f.get('geometry') or {}).get('y'), _lon=(f.get('geometry') or {}).get('x')) for f in j.get('features', [])]


def county_permits_raw(lat, lon, radius):
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({'where': '1=1', 'geometry': f'{lon},{lat}', 'geometryType': 'esriGeometryPoint', 'inSR': 4326,
            'spatialRel': 'esriSpatialRelIntersects', 'distance': radius, 'units': 'esriSRUnit_StatuteMile',
            'outFields': 'Record_ID,Type_Work,Opened_Date,Parcel_No,Address', 'returnGeometry': 'true', 'outSR': 4326,
            'orderByFields': 'OBJECTID', 'resultOffset': offset, 'resultRecordCount': 1000, 'f': 'json'})
        j = http_json(COUNTY_LAYER + '?' + q)
        feats = [dict(f['attributes'], _lat=(f.get('geometry') or {}).get('y'), _lon=(f.get('geometry') or {}).get('x')) for f in j.get('features', [])]
        out += feats
        if not j.get('exceededTransferLimit') or not feats:
            return out
        offset += len(feats)


def search_docs(permit):
    # The library matches record_id as a PREFIX (DEH1981-LWELL-997 also returns DEH1981-LWELL-9972's docs): keep exact hits only.
    q = urllib.parse.urlencode({'record_id': permit.upper(), 'doc_category': 'DEH-LWQD', 'maxrecord_count': 2000, 'ts': int(time.time() * 1000)})
    recs = http_json(DOC_API + '?' + q).get('records', [])
    return [d for d in recs if not d.get('permit_id') or d['permit_id'].strip().upper() == permit.upper()]


def apn_dashed(v):
    """County APN in the library's exact format XXX-XXX-XX-XX (10 digits; an 8-digit APN gets the -00 suffix)."""
    d = re.sub(r'\D', '', str(v or ''))
    if len(d) == 8: d += '00'
    return f'{d[:3]}-{d[3:6]}-{d[6:8]}-{d[8:10]}' if len(d) >= 10 else None


def library_parcel_docs(apn):
    """All DEH-LWQD docs filed under exactly this APN (the library matches parcel_number as a prefix too)."""
    a = apn_dashed(apn)
    q = urllib.parse.urlencode({'parcel_number': a, 'doc_category': 'DEH-LWQD', 'maxrecord_count': 2000, 'ts': int(time.time() * 1000)})
    recs = http_json(DOC_API + '?' + q).get('records', [])
    return [d for d in recs if re.sub(r'\D', '', d.get('parcel_nbr') or '')[:10] == re.sub(r'\D', '', a)]


def inside_point(rings):
    """(lat, lon) inside the parcel: area centroid of the largest ring, or (L/U-shaped parcels, where the centroid falls
    outside) the middle of the longest inside stretch of the horizontal line through it."""
    def area_c(r):
        a = cx = cy = 0.0
        for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
            k = x1 * y2 - x2 * y1; a += k; cx += (x1 + x2) * k; cy += (y1 + y2) * k
        return (a / 2, cx / (3 * a), cy / (3 * a)) if a else (0, r[0][0], r[0][1])
    def inside(x, y):
        c = False
        for r in rings:
            for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
                if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1): c = not c
        return c
    big = max(rings, key=lambda r: abs(area_c(r)[0]))
    _, x, y = area_c(big)
    if not inside(x, y):
        xs = sorted(x1 + (y - y1) * (x2 - x1) / (y2 - y1) for r in rings for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]) if (y1 > y) != (y2 > y))
        spans = [(xs[i], xs[i + 1]) for i in range(0, len(xs) - 1, 2)]
        if spans: a, b = max(spans, key=lambda t: t[1] - t[0]); x = (a + b) / 2
        else: x, y = big[0]
    return (round(y, 6), round(x, 6))


def parcels_near(lat, lon, radius=None, apn=None):
    """Assessor parcels (APN 10 digits -> centroid lat, lon) within radius mi of a point, or one APN."""
    out, offset = {}, 0
    while True:
        base = {'outFields': 'APN', 'returnGeometry': 'true', 'outSR': 4326, 'geometryPrecision': 6, 'f': 'json',
                'resultOffset': offset, 'resultRecordCount': 1000, 'orderByFields': 'APN'}
        if apn: base['where'] = f"APN='{re.sub(chr(92) + 'D', '', apn_dashed(apn))}'"
        else: base.update({'where': '1=1', 'geometry': f'{lon},{lat}', 'geometryType': 'esriGeometryPoint', 'inSR': 4326,
                           'spatialRel': 'esriSpatialRelIntersects', 'distance': radius, 'units': 'esriSRUnit_StatuteMile'})
        j = http_json(PARCEL_LAYER + '?' + urllib.parse.urlencode(base))
        feats = j.get('features', [])
        for f in feats:
            rings = (f.get('geometry') or {}).get('rings', [])
            if rings and f['attributes'].get('APN'):
                out[f['attributes']['APN']] = inside_point(rings)
        if not j.get('exceededTransferLimit') or not feats: break
        offset += len(feats)
    return out


def library_only_permits(parcels, known, delay=0.5):
    """LWELL permits filed in the DEH library under these parcels that are NOT in the county GIS layer (the layer stops
    at Aug 2020). Returns {permit: (lat, lon, apn)} with the parcel centroid as the location. Several wells per APN are kept."""
    out = {}
    for i, (apn, (la, lo)) in enumerate(sorted(parcels.items()), 1):
        try: docs = library_parcel_docs(apn)
        except Exception as e: log(f'library parcel search {apn} failed: {e}'); continue
        for d in docs:
            pid = (d.get('permit_id') or '').strip().upper()
            if re.search(r'-LWELL-', pid) and pid not in known and pid not in out:
                out[pid] = (la, lo, apn_dashed(apn))
        if i % 50 == 0: log(f'library parcel scan {i}/{len(parcels)}: {len(out)} library-only well permits so far')
        time.sleep(delay)
    # `known` is only the layer permits near the area: drop candidates that ARE in the layer (at a point elsewhere)
    in_layer = permit_coords(list(out))
    if in_layer: log(f'{len(in_layer)} candidates are in the GIS layer elsewhere, not library-only: {sorted(in_layer)}')
    return {k: v for k, v in out.items() if k not in in_layer}


def doc_priority(d):
    desc = (d.get('description') or '').lower()
    sub = (d.get('lueg_subtype') or '').lower()
    if re.search(r'wcr|completion|well log|driller', desc): p = 0
    elif re.search(r'final inspection', desc): p = 3
    elif re.search(r'^approved', desc): p = 2
    elif 'water well permit' in sub: p = 1
    else: p = 4
    return (p, -(int(d.get('r_content_size') or 0)))  # larger files first within a class (more pages -> more likely to include the log)


class Viewer:
    """Loads a document in the county's public viewer and captures the PDF bytes it receives."""
    def __init__(self):
        from playwright.sync_api import sync_playwright
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        self.page = self._new_page()

    def _new_page(self):
        return self.browser.new_page(user_agent=UA)

    def fetch(self, file_id):
        try:
            return self._fetch(file_id)
        except Exception as e:
            # e.g. "Request content was evicted from inspector cache" (large PDFs overflow the inspector buffer):
            # retry on a fresh page, fetching the file response ourselves through a route (no inspector buffer)
            log(f'viewer {file_id}: {str(e)[:80]} -> retry via route on a fresh page')
            try: self.page.close()
            except Exception: pass
            self.page = self._new_page()
            time.sleep(3)
            return self._fetch_routed(file_id)

    def _fetch_routed(self, file_id):
        box = {}
        def handler(route):
            r = route.fetch(timeout=120000)
            box['body'] = r.body()
            route.fulfill(response=r)
        pat = '**/*DataActionGetFile*'
        self.page.route(pat, handler)
        try:
            self.page.goto(VIEWER + str(file_id), wait_until='domcontentloaded', timeout=90000)
            t0 = time.time()
            while 'body' not in box and time.time() - t0 < 120:
                self.page.wait_for_timeout(500)
        finally:
            try: self.page.unroute(pat)
            except Exception: pass
        if 'body' not in box: raise RuntimeError('file response not seen (routed)')
        j = json.loads(box['body'])
        b64 = (((j.get('data') or {}).get('File') or {}).get('BinaryData')) or ''
        data = base64.b64decode(b64) if b64 else b''
        return data if data[:4] == b'%PDF' else None

    def _fetch(self, file_id):
        with self.page.expect_response(lambda r: 'DataActionGetFile' in r.url, timeout=90000) as resp:
            self.page.goto(VIEWER + str(file_id), wait_until='domcontentloaded', timeout=90000)
        j = resp.value.json()
        b64 = (((j.get('data') or {}).get('File') or {}).get('BinaryData')) or ''
        data = base64.b64decode(b64) if b64 else b''
        return data if data[:4] == b'%PDF' else None

    def close(self):
        try: self.browser.close(); self.pw.stop()
        except Exception: pass


# ---------------------------------------------------------------- text extraction
def run(cmd, **kw):
    kw.setdefault('timeout', 180)
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def pdf_info(path):
    info = run(['pdfinfo', path]).stdout
    pages = int((re.search(r'Pages:\s+(\d+)', info) or [0, 0])[1])
    creator = ' '.join(re.findall(r'(?:Creator|Producer):\s+(.*)', info))
    imgs = run(['pdfimages', '-list', path]).stdout.strip().splitlines()[2:]
    img_pages = {int(l.split()[0]) for l in imgs if l.split() and l.split()[0].isdigit()}
    return pages, creator, img_pages


WCR_PAGE = re.compile(r'well\s*completion|completion\s*report|dwr\s*-?\s*188|total\s+depth\s+of\s+(completed|boring)|water\s+level\s*(and|&)\s*yield|geologic\s+log'
                      # 1970s-80s county form "WATER WELL DRILLERS REPORT" / "Well driller's report and Log" / "WELL DRILLER'S STATEMENT"
                      # (not the modern permit condition "a Water Well Drillers Report must be submitted", nor "(well driller's report)")
                      r"|water\s+well\s+drill+ers?\W{0,3}s?\s+report(?!\W{0,3}(must|shall|is\s+required|to\s+be|within))"
                      r"|well\s+drill+ers?\W{0,3}s?\s+statement|drill+ers?\W{0,3}s?\s+report\s+and\s+log", re.I)


# Some county text layers are letter-spaced ("N otice of Intent N o.", "W A T E R  W E L L"): also test the layer with all
# whitespace/punctuation removed against compact keywords.
WCR_COMPACT = re.compile(r'wellcompletion|completionreport|dwr188|totaldepthof(completed|boring)|waterlevel(and)?yield|geologiclog'
                         # OCR'd layers garble letters ("REPORJ", "SFATEMENT"): stems, not whole words
                         r'|waterwelldrill+ers?s?repor(?!t?(must|shall|isrequired|tobe|within))|welldrill+ers?s?.tatement|drill+ers?s?reportandlog|welllogtotal')


def layer_is_wcr(text):
    return bool(WCR_PAGE.search(text) or WCR_COMPACT.search(re.sub(r'[^a-z0-9]', '', text.lower())))


def ocr_page(pdf, page, tmp):
    """Returns (text, words) where words = [(start, end, conf)] offsets into text."""
    png = os.path.join(tmp, f'p{page}')
    run(['pdftoppm', '-r', '300', '-gray', '-png', '-f', str(page), '-l', str(page), '-singlefile', pdf, png])
    tsv = run(['tesseract', png + '.png', '-', '--psm', '4', 'tsv']).stdout
    lines, cur_key, text, words = [], None, '', []
    for row in tsv.splitlines()[1:]:
        c = row.split('\t')
        if len(c) < 12 or c[0] != '5' or not c[11].strip():
            continue
        key = (c[2], c[3], c[4])
        if cur_key is not None and key != cur_key:
            text += '\n'
        elif cur_key is not None:
            text += ' '
        cur_key = key
        s = len(text); text += c[11]; words.append((s, len(text), float(c[10])))
    return text, words


def span_conf(words, a, b):
    cs = [c for (s, e, c) in words if e > a and s < b]
    return min(cs) if cs else None


def clean_num(s):
    s = s.replace(',', '').replace('O', '0').replace('o', '0').replace('l', '1').replace('I', '1')
    m = re.match(r'\d+(\.\d+)?', s)
    return float(m.group(0)) if m else None


def parse_fields(text, words, source):
    """Parse WCR fields from text. source: 'text' (generated PDF text) or 'ocr'. Returns dict of field -> {value, conf, raw}."""
    t = re.sub(r'\bA[l1I]r\b', 'Air', text)
    out = {}

    def conf_for(m, g=1):
        if source == 'text':
            return 'high', None
        c = span_conf(words, m.start(g), m.end(g))
        return ('high' if c is not None and c >= 80 else 'medium' if c is not None and c >= 50 else 'low'), c

    def num_field(name, patterns):
        for p in patterns:
            for m in re.finditer(p, t, re.I):
                v = clean_num(m.group(1))
                if v is None: continue
                lo, hi = BOUNDS[name]
                if not (lo <= v <= hi): continue
                lvl, c = conf_for(m)
                out[name] = {'value': v, 'conf': lvl, 'ocrConf': c, 'raw': m.group(0)[:80]}
                return
    N = r'([0-9O][0-9O,]*(?:\.[0-9]+)?)'
    num_field('depthFt', [r'total\s+depth\s+of\s+completed\s+well[\s_:.\-\(\)]*' + N])  # (a looser 'completed well N ft' pattern matched setback text; removed)
    if 'depthFt' not in out:
        num_field('depthFt', [r'total\s+depth\s+of\s+boring[\s_:.\-]*' + N])
        if 'depthFt' in out:
            # Completed depth unreadable (usually handwriting) -> the boring depth is less trustworthy: one level down.
            out['depthFt']['note'] = 'total depth of boring (completed depth not read)'
            out['depthFt']['conf'] = {'high': 'medium', 'medium': 'low'}.get(out['depthFt']['conf'], 'low')
    num_field('gpm', [r'estimated\s+yield\W{0,8}' + N + r'\s*[^0-9\n]{0,6}\(?\s*gpm', r'yield\W{0,8}' + N + r'\s*\(?\s*gpm'])
    num_field('swlFt', [r'depth\s+to\s+static[\s_:.\-]*' + N + r'[ \t]*(?:\n|\(|f)', r'water\s+level[\s_:.\-]*' + N + r'[^0-9\n]{0,8}\(\s*f(?:ee)?t', r'static\s+water\s+level[\s_:.\-]*' + N + r'\s*\(?\s*f(?:ee)?t'])

    if 'swlFt' in out and 'depthFt' in out and out['swlFt']['value'] >= out['depthFt']['value']:
        out['swlFt']['conf'] = 'low'; out['swlFt']['note'] = 'SWL >= depth (misread)'

    m = re.search(r'drilling\s+method[\s_:.\-]*([A-Za-z][A-Za-z \-]{1,30}?)\s*(?:drilling\s+)?fluid[\s_:.\-]*([A-Za-z]{2,12})?', t, re.I)
    if m:
        meth = m.group(1).strip().lower()
        hit = next((w for w in METHOD_WORDS if w in meth), None)
        if hit:
            lvl, c = conf_for(m, 1)
            out['method'] = {'value': m.group(1).strip().title(), 'conf': lvl, 'ocrConf': c, 'raw': m.group(0)[:80]}
        if m.group(2) and m.group(2).lower() in FLUID_WORDS:
            lvl, c = conf_for(m, 2)
            out['fluid'] = {'value': m.group(2).title(), 'conf': lvl, 'ocrConf': c}

    m = re.search(r'(?:work\s+)?ended[\s_:.,\-]*([0-9]{1,2})\s*[/\-.]\s*([0-9]{1,2})\s*[/\-.]\s*([0-9]{2,4})', t, re.I)
    if m:
        mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100: y += 1900 if y > 30 else 2000
        try:
            date = dt.date(y, mo, d)
            if 1950 <= y <= dt.date.today().year:
                lvl, c = conf_for(m, 3)
                out['dateEnded'] = {'value': date.isoformat(), 'conf': lvl, 'ocrConf': c}
        except ValueError:
            pass

    la = re.search(r'dec\.?\s*lat\.?[\s:_\-]*([0-9]{2}\s?\.\s?[0-9]{3,})', t, re.I)
    lo = re.search(r'dec\.?\s*long\.?[\s:_]*(-?\s*[0-9]{3}\s?\.\s?[0-9]{3,})', t, re.I)
    if la and lo:
        lat = float(la.group(1).replace(' ', '')); lon = float(lo.group(1).replace(' ', ''))
        if lon > 0: lon = -lon
        if LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LON_RANGE[0] <= lon <= LON_RANGE[1]:
            l1, _ = conf_for(la); l2, _ = conf_for(lo)
            order = ['low', 'medium', 'high']
            out['gps'] = {'lat': lat, 'lon': lon, 'conf': order[min(order.index(l1), order.index(l2))]}

    if re.search(r'destroy\s+well\s+as\s+follows|destruction\s+details|[®☒✓xX]\s*destroy\b', t, re.I):
        out['activity'] = 'destroy'
    return out


def read_pdf(path, tmp):
    """Returns list of pages that look like WCRs: [{page, source, fields, chars}]."""
    pages, creator, img_pages = pdf_info(path)
    generated = not img_pages
    res = []
    for p in range(1, pages + 1):
        layer = run(['pdftotext', '-layout', '-f', str(p), '-l', str(p), path, '-']).stdout
        if generated or p not in img_pages:
            if layer_is_wcr(layer):
                res.append({'page': p, 'source': 'text', 'fields': parse_fields(layer, [], 'text'), 'chars': len(layer), 'text': layer, 'words': []})
            continue
        # scanned page: use the county's own text layer (if any) only to decide whether it's a WCR page
        # ignore the redaction notice overlay (added to redacted scans) when judging whether a real text layer exists
        stripped = re.sub(r'the\s+information\s+in\s+this\s+grayed.*?personal\s+information\.?', '', layer, flags=re.I | re.S)
        has_layer = len(re.sub(r'\s', '', stripped)) > 300
        if has_layer and not layer_is_wcr(layer):
            continue
        if not has_layer and p > MAX_OCR_PAGES:
            continue
        text, words = ocr_page(path, p, tmp)
        if WCR_PAGE.search(text) or (has_layer and layer_is_wcr(layer)):
            res.append({'page': p, 'source': 'ocr', 'fields': parse_fields(text, words, 'ocr'), 'chars': len(text), 'text': text, 'words': words})
    return res


KEY_FIELDS = ['depthFt', 'gpm', 'swlFt', 'method', 'dateEnded']


def merge_pages(pages):
    """Pick the best value per field across WCR pages (highest confidence)."""
    order = {'high': 3, 'medium': 2, 'low': 1}
    best = {}
    for pg in pages:
        for k, v in pg['fields'].items():
            if k == 'activity':
                best['activity'] = v; continue
            if k not in best or order.get(v.get('conf'), 0) > order.get(best[k].get('conf'), 0):
                best[k] = dict(v, page=pg['page'], source=pg['source'])
    return best


# Errors that mean "we could not look", not "there is no report": a permit with one of these and no WCR page found is
# classified 'error' (retried), never 'no_wcr'. (Sep 2026: tesseract vanished after a box restart and ~2,300 permits were
# silently marked no_wcr.)
HARD_ERROR = re.compile(r'^(read|viewer|no pdf|search)\b', re.I)


def classify(record):
    f = record['fields']
    if not record['wcrPages'] and any(HARD_ERROR.search(e) for e in record.get('errors', [])):
        return 'error'

    usable = [k for k in KEY_FIELDS if k in f and f[k]['conf'] in ('high', 'medium')]
    if not record['docs']:
        return 'no_docs'
    if not record['wcrPages']:
        return 'no_wcr'
    if f.get('activity') == 'destroy':
        return 'destruction_wcr'
    if 'depthFt' in usable and len(usable) >= 2:
        return 'readable'
    if usable:
        return 'partial'
    return 'unreadable'


REQUIRED_TOOLS = ['tesseract', 'pdftoppm', 'pdftotext', 'pdfimages', 'pdfinfo']


def preflight():
    """Fail loudly (exit 4) if an OCR/PDF tool is missing or tesseract can't read English — instead of silently
    classifying every scanned report as no_wcr."""
    missing = [t for t in REQUIRED_TOOLS if not shutil.which(t)]
    if not missing:
        langs = run(['tesseract', '--list-langs'], timeout=30)
        if 'eng' not in (langs.stdout + langs.stderr).split():
            missing.append('tesseract language data "eng" (tesseract-ocr-eng)')
    if not os.path.exists('/usr/bin/google-chrome'):
        missing.append('/usr/bin/google-chrome')
    if missing:
        log('PREFLIGHT FAILED — missing: ' + ', '.join(missing) + '.  Fix: sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils')
        sys.exit(4)


def process_permit(permit, viewer, delay, tmp):
    rec = {'permit': permit, 'processed': dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'version': SCRIPT_VERSION,
           'docs': [], 'wcrPages': [], 'fields': {}, 'bestDocUrl': None, 'errors': []}
    try:
        docs = search_docs(permit)
    except Exception as e:
        rec['errors'].append(f'search: {e}'); rec['status'] = 'error'; return rec
    time.sleep(delay)
    docs = [d for d in docs if (d.get('a_content_type') or '').upper() == 'PDF']
    docs.sort(key=doc_priority)
    rec['docs'] = [{'url': d['url'], 'desc': d.get('description') or '', 'subtype': (d.get('lueg_subtype') or '').replace('DEH-LWQD-', ''),
                    'scanned': (d.get('r_creation_date') or '')[:10], 'kb': round(int(d.get('r_content_size') or 0) / 1024)} for d in docs]
    all_pages = []
    for d in docs[:MAX_DOCS]:
        size = int(d.get('r_content_size') or 0)
        if size > MAX_DOC_BYTES:
            rec['errors'].append(f"skipped large doc {d['url']}"); continue
        fid = re.search(r'FileRecordId=(\d+)', d['url']).group(1)
        try:
            pdf = viewer.fetch(fid)
        except Exception as e:
            rec['errors'].append(f'viewer {fid}: {str(e)[:120]}'); time.sleep(delay); continue
        time.sleep(delay)
        if not pdf:
            rec['errors'].append(f'no pdf {fid}'); continue
        path = os.path.join(tmp, f'{fid}.pdf')
        open(path, 'wb').write(pdf)
        try:
            pages = read_pdf(path, tmp)
        except Exception as e:
            rec['errors'].append(f'read {fid}: {e}'); pages = []
        for pg in pages:
            pg['url'] = d['url']
            all_pages.append(pg)
        rec['wcrPages'] += [{'url': d['url'], 'page': pg['page'], 'source': pg['source'], 'nFields': len([k for k in pg['fields'] if k in KEY_FIELDS])} for pg in pages]
        merged = merge_pages(all_pages)
        if 'depthFt' in merged and len([k for k in KEY_FIELDS if k in merged and merged[k]['conf'] != 'low']) >= 3:
            break  # good enough; don't download more
    os.makedirs(PAGE_CACHE, exist_ok=True)
    json.dump([{k: pg[k] for k in ('url', 'page', 'source', 'text', 'words')} for pg in all_pages], open(os.path.join(PAGE_CACHE, permit + '.json'), 'w'))
    finalize(rec, all_pages)
    return rec


def finalize(rec, all_pages):
    rec['fields'] = merge_pages(all_pages)
    if rec['wcrPages']:
        # most likely completion report: the WCR page with the most fields (ties: first)
        best = max(rec['wcrPages'], key=lambda p: p['nFields'])
        rec['bestDocUrl'] = best['url']; rec['bestDocPage'] = best['page']
    elif rec['docs']:
        rec['bestDocUrl'] = rec['docs'][0]['url']
    rec['status'] = classify(rec)


def load_rec(permit):
    try: return json.load(open(os.path.join(OUT, permit + '.json')))
    except Exception: return None


def reparse_all():
    """Re-run the parser on cached page text (no network). Use after improving parse_fields()."""
    n = 0
    for f in sorted(glob.glob(os.path.join(OUT, 'DEH*.json'))):
        rec = json.load(open(f)); cp = os.path.join(PAGE_CACHE, rec['permit'] + '.json')
        if not os.path.exists(cp): continue
        pages = json.load(open(cp))
        for pg in pages:
            pg['fields'] = parse_fields(pg['text'], [tuple(w) for w in pg['words']], pg['source'])
        rec['wcrPages'] = [{'url': pg['url'], 'page': pg['page'], 'source': pg['source'], 'nFields': len([k for k in pg['fields'] if k in KEY_FIELDS])} for pg in pages]
        finalize(rec, pages)
        json.dump(rec, open(f, 'w'), indent=1); n += 1
    log(f'reparsed {n} permits; index has {rebuild_index()}')


TILE_DEG = 0.025          # shard grid: tile (iy, ix) covers lat [iy*D, (iy+1)*D), lon [ix*D, (ix+1)*D)
TILES = os.path.join(OUT, 'tiles')
LEGACY_INDEX = False      # True = also write the old single index.json (pre-shard app); False = tiny stub
ALL_PERMITS_CACHE = os.path.join(os.environ.get('WELLS_STATE', '/workspace/wells-state'), 'all-permits.json')  # tools/build_spiral_plan.py; optional


def tile_key(lat, lon):
    return f'{math.floor(lat / TILE_DEG + 1e-9)}_{math.floor(lon / TILE_DEG + 1e-9)}'


def tile_bounds(key):
    iy, ix = (int(x) for x in key.split('_'))
    return [round(iy * TILE_DEG, 6), round(ix * TILE_DEG, 6), round((iy + 1) * TILE_DEG, 6), round((ix + 1) * TILE_DEG, 6)]  # s, w, n, e


def permit_coords(permits):
    """Parcel point (lat, lon) of each permit from the county layer: local cache first, then the layer itself (batched)."""
    out = {}
    try:
        for p in json.load(open(ALL_PERMITS_CACHE)):
            if p.get('lat') is not None: out[p['id'].upper()] = (p['lat'], p['lon'])
    except Exception:
        pass
    want = [p for p in permits if p not in out]
    for i in range(0, len(want), 100):
        ids = ','.join("'" + p.replace("'", '') + "'" for p in want[i:i + 100])
        q = urllib.parse.urlencode({'where': f'Record_ID IN ({ids})', 'outFields': 'Record_ID', 'returnGeometry': 'true', 'outSR': 4326, 'f': 'json'})
        try:
            for f in http_json(COUNTY_LAYER + '?' + q).get('features', []):
                g = f.get('geometry') or {}
                if g.get('y') is not None: out[f['attributes']['Record_ID'].upper()] = (g['y'], g['x'])
        except Exception as e:
            log('coordinate lookup failed:', e)
        time.sleep(1)
    return {p: out[p] for p in permits if p in out}


def slim(r):
    """What the app needs per permit (see js/countywcr.js)."""
    f = {}
    for k, v in (r.get('fields') or {}).items():
        if k == 'activity': f[k] = v
        elif k == 'gps': f[k] = {'lat': v['lat'], 'lon': v['lon'], 'conf': v['conf']}
        elif isinstance(v, dict): f[k] = {'value': v.get('value'), 'conf': v.get('conf')}
    e = {'status': r.get('status'), 'fields': f, 'bestDocUrl': r.get('bestDocUrl')}
    if r.get('bestDocPage'): e['bestDocPage'] = r['bestDocPage']
    if r.get('libraryOnly') and r.get('lat') is not None:
        # permit not in the county GIS layer (opened after Aug 2020): the app adds it as a county record from this
        dates = sorted(d['scanned'] for d in r.get('docs') or [] if d.get('scanned'))
        e['lib'] = {'lat': r['lat'], 'lon': r['lon'], 'apn': r.get('apn'), 'firstDoc': dates[0] if dates else None}
    return e


def rebuild_index():
    """Rebuild tiles/*.json + manifest.json (and the legacy index.json) from all per-permit files. Returns permit count."""
    recs, missing = {}, []
    for f in sorted(glob.glob(os.path.join(OUT, 'DEH*.json'))):
        r = json.load(open(f)); recs[r['permit']] = (f, r)
        if r.get('lat') is None: missing.append(r['permit'])
    if missing:  # backfill parcel points into the permit files (once)
        co = permit_coords(missing)
        for p, (la, lo) in co.items():
            f, r = recs[p]; r['lat'], r['lon'] = la, lo
            json.dump(r, open(f, 'w'), indent=1)
    tiles, unplaced = {}, []
    for p, (f, r) in recs.items():
        if r.get('lat') is None: unplaced.append(p); continue
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
        if os.path.basename(path)[:-5] not in man: os.remove(path)
    if unplaced: log(f'{len(unplaced)} permits without a parcel point (not in any tile): {",".join(unplaced[:10])}')
    now = dt.datetime.now().astimezone().isoformat(timespec='seconds')
    json.dump({'version': 1, 'generated': now, 'tileDeg': TILE_DEG, 'count': sum(m['n'] for m in man.values()),
               'boundsOrder': 'south,west,north,east', 'tiles': man},
              open(os.path.join(OUT, 'manifest.json'), 'w'), separators=(',', ':'))
    if LEGACY_INDEX:
        idx = {p: {k: r.get(k) for k in ('status', 'processed', 'fields', 'bestDocUrl', 'bestDocPage', 'area')} | {'nDocs': len(r.get('docs', [])), 'nWcrPages': len(r.get('wcrPages', []))}
               for p, (f, r) in recs.items()}
        json.dump({'generated': now, 'count': len(idx), 'permits': idx}, open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'))
    else:
        json.dump({'moved': 'manifest.json (per-tile shards in tiles/)', 'count': 0, 'permits': {}}, open(os.path.join(OUT, 'index.json'), 'w'))
    return len(recs)


PERMIT_TIMEOUT_S = 300


class PermitTimeout(Exception):
    pass


def _on_alarm(signum, frame):
    raise PermitTimeout()


def main():
    signal.signal(signal.SIGALRM, _on_alarm)
    ap = argparse.ArgumentParser()
    ap.add_argument('--lat', type=float); ap.add_argument('--lon', type=float); ap.add_argument('--radius', type=float, default=1.0)
    ap.add_argument('--area', default=''); ap.add_argument('--permits', default='')
    ap.add_argument('--include-destruction', action='store_true'); ap.add_argument('--force', action='store_true')
    ap.add_argument('--delay', type=float, default=2.5); ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--reparse', action='store_true', help='re-parse cached page text, no network')
    ap.add_argument('--corridor', default='', help='"lat,lon;lat,lon;..." polyline: permits within --buffer mi of it')
    ap.add_argument('--buffer', type=float, default=0.5)
    ap.add_argument('--list-only', action='store_true', help='print the permits that would be processed and exit')
    ap.add_argument('--apns', default='', help='comma list of APNs: process every LWELL permit filed under them in the DEH library')
    ap.add_argument('--library-parcels', action='store_true', help='radius mode: also scan every parcel in the radius in the DEH '
                    'library for well permits missing from the GIS layer (layer ends Aug 2020)')
    a = ap.parse_args()
    if a.reparse:
        return reparse_all()
    os.makedirs(OUT, exist_ok=True)
    preflight()
    coords, apn_of = {}, {}
    if a.apns:
        permits = []
        for apn in [x.strip() for x in a.apns.split(',') if x.strip()]:
            par = parcels_near(None, None, apn=apn)
            ll = next(iter(par.values()), (None, None))
            docs = library_parcel_docs(apn)
            ids = list(dict.fromkeys((d.get('permit_id') or '').strip().upper() for d in docs if re.search(r'-LWELL-', d.get('permit_id') or '')))
            layer = county_permits_where(f"Parcel_No='{apn_dashed(apn)}'")
            ids += [f['Record_ID'].upper() for f in layer if f['Record_ID'].upper() not in ids]
            for f in layer: coords[f['Record_ID'].upper()] = (f['_lat'], f['_lon'])
            coords.update(permit_coords([pid for pid in ids if pid not in coords]))  # in the layer under another APN
            for pid in ids:
                if pid not in coords and ll[0] is not None: coords[pid] = ll; apn_of[pid] = apn_dashed(apn)
            log(f'APN {apn_dashed(apn)}: {len(docs)} library docs, well permits {ids} ({len(layer)} in GIS layer), parcel centroid {ll}')
            permits += ids
    elif a.permits:
        permits = [p.strip().upper() for p in a.permits.split(',') if p.strip()]
    elif a.corridor:
        path = [tuple(float(v) for v in pt.split(',')) for pt in a.corridor.split(';') if pt.strip()]
        circles, dist = corridor_circles(path, a.buffer)
        feats, par = {}, {}
        for (la, lo, r) in circles:
            for f in county_permits_raw(la, lo, r):
                if f.get('Record_ID') and f.get('_lat') is not None and dist((f['_lat'], f['_lon'])) <= a.buffer: feats[f['Record_ID'].upper()] = f
            if a.library_parcels:
                par.update({k: v for k, v in parcels_near(la, lo, r).items() if dist(v) <= a.buffer})
        feats = list(feats.values())
        coords = {f['Record_ID'].upper(): (f['_lat'], f['_lon']) for f in feats}
        permits = [f['Record_ID'].upper() for f in feats if a.include_destruction or not re.search(r'destr', f.get('Type_Work') or '', re.I)]
        log(f'{len(feats)} county permits within {a.buffer} mi of the corridor ({len(circles)} query circles), {len(permits)} to consider')
        if a.library_parcels:
            known = set(coords)
            log(f'scanning {len(par)} corridor parcels in the DEH library for well permits missing from the GIS layer…')
            extra = library_only_permits(par, known)
            for pid, (la, lo, apn) in extra.items(): coords[pid] = (la, lo); apn_of[pid] = apn
            permits += list(extra)
            log(f'{len(extra)} library-only well permits: {sorted(extra)}')
    else:
        feats = county_permits(a.lat, a.lon, a.radius)
        coords = {f['Record_ID'].upper(): (f['_lat'], f['_lon']) for f in feats if f.get('Record_ID') and f.get('_lat') is not None}
        permits = [f['Record_ID'] for f in feats if f.get('Record_ID') and (a.include_destruction or not re.search(r'destr', f.get('Type_Work') or '', re.I))]
        log(f'{len(feats)} county permits in {a.radius} mi, {len(permits)} to consider (destruction excluded: {not a.include_destruction})')
        if a.library_parcels:
            par = parcels_near(a.lat, a.lon, a.radius)
            known = {f['Record_ID'].upper() for f in county_permits_raw(a.lat, a.lon, a.radius * 1.25) if f.get('Record_ID')}
            log(f'scanning {len(par)} parcels in the DEH library for well permits missing from the GIS layer…')
            extra = library_only_permits(par, known)
            for pid, (la, lo, apn) in extra.items(): coords[pid] = (la, lo); apn_of[pid] = apn
            permits += list(extra)
            log(f'{len(extra)} library-only well permits: {sorted(extra)}')
    if a.list_only:
        print(json.dumps({'permits': list(dict.fromkeys(permits)), 'libraryOnly': apn_of, 'coords': {p: coords.get(p) for p in permits}}))
        return
    todo = [p for p in dict.fromkeys(permits) if a.force or not os.path.exists(os.path.join(OUT, p + '.json'))]
    if a.limit: todo = todo[:a.limit]
    log(f'{len(todo)} permits to process ({len(permits) - len(todo)} already cached)')
    missing = [p for p in todo if p not in coords]
    if missing: coords.update(permit_coords(missing))
    viewer = Viewer()
    stats = {}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            for i, p in enumerate(todo, 1):
                t0 = time.time()
                signal.alarm(PERMIT_TIMEOUT_S)  # watchdog: the headless viewer occasionally hangs
                try:
                    rec = process_permit(p, viewer, a.delay, tmp)
                except PermitTimeout:
                    rec = {'permit': p, 'processed': dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'version': SCRIPT_VERSION,
                           'docs': [], 'wcrPages': [], 'fields': {}, 'bestDocUrl': None, 'status': 'error',
                           'errors': [f'timeout after {PERMIT_TIMEOUT_S}s (retry with --permits {p} --force)']}
                    viewer.close(); viewer = Viewer()
                finally:
                    signal.alarm(0)
                old = load_rec(p)
                rec['area'] = a.area or (old or {}).get('area', '')
                if old and old.get('status') == 'error' and rec['status'] == 'error':
                    rec['retries'] = old.get('retries', 0) + 1
                if p in coords: rec['lat'], rec['lon'] = coords[p]
                elif old and old.get('lat') is not None: rec['lat'], rec['lon'] = old['lat'], old['lon']
                if p in apn_of: rec['apn'], rec['libraryOnly'] = apn_of[p], True
                elif old and old.get('libraryOnly') and p not in coords: rec['apn'], rec['libraryOnly'] = old.get('apn'), True
                json.dump(rec, open(os.path.join(OUT, p + '.json'), 'w'), indent=1)
                stats[rec['status']] = stats.get(rec['status'], 0) + 1
                f = rec['fields']
                log(f"[{i}/{len(todo)}] {p}: {rec['status']} docs={len(rec['docs'])} wcrPages={len(rec['wcrPages'])} "
                    + ' '.join(f"{k}={f[k]['value']}({f[k]['conf'][0]})" for k in KEY_FIELDS if k in f) + f" {time.time() - t0:.0f}s")
                for fn in glob.glob(os.path.join(tmp, '*')): os.remove(fn)
                if i % 10 == 0: rebuild_index()
    finally:
        viewer.close()
        n = rebuild_index()
    log('done', stats, f'index has {n} permits')


if __name__ == '__main__':
    main()
