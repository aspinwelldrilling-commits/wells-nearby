#!/usr/bin/env python3
"""Extract well data from San Diego County DEHQ well completion reports (WCRs).

For each county water-well permit in an area:
  1. list its documents in the DEHQ Environmental Health Document Library (JSON search API),
  2. open the most likely documents in the county's public viewer (headless browser) to get the PDF,
  3. find WCR pages and read them:  generated/text PDFs -> pdftotext;  scans -> tesseract (typed forms only;
     handwriting is not readable with tesseract and is reported as 'unreadable'),
  4. parse depth, drilling method/fluid, yield (GPM), static water level, date work ended, decimal lat/lon,
     with per-field confidence (tesseract word confidence) and plausibility checks,
  5. write data/county-wcr/<PERMIT>.json and rebuild data/county-wcr/index.json (what the app loads).

Polite: one request at a time, --delay seconds (default 2.5) between county requests. Cached permits are skipped
unless --force. Requires: poppler-utils (pdftotext/pdfimages/pdftoppm), tesseract-ocr, playwright + Chrome.

Usage:
  /workspace/.venv-pw/bin/python tools/extract_county_wcr.py --lat 33.0417 --lon -116.8681 --radius 1 --area ramona
  /workspace/.venv-pw/bin/python tools/extract_county_wcr.py --permits DEH2014-LWELL-000720,DEH2016-LWELL-001272
"""
import argparse, base64, datetime as dt, glob, json, os, re, signal, subprocess, sys, tempfile, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'county-wcr')
PAGE_CACHE = os.path.join(ROOT, '.cache', 'wcr-pages')   # page text + word confidences (local only, for --reparse)
COUNTY_LAYER = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/100/query'
DOC_API = 'https://file.sandiegocounty.gov/CoSD_LUEG_Repository_External_API/rest/DEHQDocumentLibrary/SearchDocuments'
VIEWER = 'https://file.sandiegocounty.gov/LUEG/LUEG_View?FileRecordId='
UA = 'WellsNearby-extractor/1.0 (small-business field tool; low-rate)'
SCRIPT_VERSION = 2
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
    q = urllib.parse.urlencode({'record_id': permit.upper(), 'doc_category': 'DEH-LWQD', 'maxrecord_count': 350, 'ts': int(time.time() * 1000)})
    return http_json(DOC_API + '?' + q).get('records', [])


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
        self.page = self.browser.new_page(user_agent=UA)

    def fetch(self, file_id):
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


WCR_PAGE = re.compile(r'well\s*completion|completion\s*report|dwr\s*-?\s*188|total\s+depth\s+of\s+(completed|boring)|water\s+level\s*(and|&)\s*yield|geologic\s+log', re.I)


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
            if WCR_PAGE.search(layer):
                res.append({'page': p, 'source': 'text', 'fields': parse_fields(layer, [], 'text'), 'chars': len(layer), 'text': layer, 'words': []})
            continue
        # scanned page: use the county's own text layer (if any) only to decide whether it's a WCR page
        # ignore the redaction notice overlay (added to redacted scans) when judging whether a real text layer exists
        stripped = re.sub(r'the\s+information\s+in\s+this\s+grayed.*?personal\s+information\.?', '', layer, flags=re.I | re.S)
        has_layer = len(re.sub(r'\s', '', stripped)) > 300
        if has_layer and not WCR_PAGE.search(layer):
            continue
        if not has_layer and p > MAX_OCR_PAGES:
            continue
        text, words = ocr_page(path, p, tmp)
        if WCR_PAGE.search(text) or (has_layer and WCR_PAGE.search(layer)):
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


def classify(record):
    f = record['fields']
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


def rebuild_index():
    idx = {}
    for f in sorted(glob.glob(os.path.join(OUT, 'DEH*.json'))):
        r = json.load(open(f))
        idx[r['permit']] = {k: r.get(k) for k in ('status', 'processed', 'fields', 'bestDocUrl', 'bestDocPage', 'area')} | {'nDocs': len(r.get('docs', [])), 'nWcrPages': len(r.get('wcrPages', []))}
    json.dump({'generated': dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'count': len(idx), 'permits': idx},
              open(os.path.join(OUT, 'index.json'), 'w'), separators=(',', ':'))
    return len(idx)


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
    a = ap.parse_args()
    if a.reparse:
        return reparse_all()
    os.makedirs(OUT, exist_ok=True)
    if a.permits:
        permits = [p.strip().upper() for p in a.permits.split(',') if p.strip()]
    else:
        feats = county_permits(a.lat, a.lon, a.radius)
        permits = [f['Record_ID'] for f in feats if f.get('Record_ID') and (a.include_destruction or not re.search(r'destr', f.get('Type_Work') or '', re.I))]
        log(f'{len(feats)} county permits in {a.radius} mi, {len(permits)} to consider (destruction excluded: {not a.include_destruction})')
    todo = [p for p in dict.fromkeys(permits) if a.force or not os.path.exists(os.path.join(OUT, p + '.json'))]
    if a.limit: todo = todo[:a.limit]
    log(f'{len(todo)} permits to process ({len(permits) - len(todo)} already cached)')
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
                rec['area'] = a.area
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
