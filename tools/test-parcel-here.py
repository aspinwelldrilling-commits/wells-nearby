"""Phone-view check of the 'This parcel' card: a search at a parcel lists every well permit filed under its APN in the
DEH library (incl. permits newer than the county GIS layer), their WCR status, and septic status + records.
Usage: python tools/test-parcel-here.py [--base URL] [--lat 32.99521 --lon -116.92256] [--expect DEH2024-LWELL-003623]"""
import sys, os, http.server, threading, functools, argparse, re
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('--base'); ap.add_argument('--lat', type=float, default=32.99521); ap.add_argument('--lon', type=float, default=-116.92256)
ap.add_argument('--expect', default='DEH2024-LWELL-003623'); ap.add_argument('--apn', default='285-030-06-00'); ap.add_argument('--shot')
a = ap.parse_args()
base = a.base
if not base:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_address[1]}/'
fail = []
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'{base}?lat={a.lat}&lon={a.lon}&r=0.25&view=both', wait_until='load')
    pg.wait_for_selector('#parcelCard:not(.hidden)', timeout=60000)
    pg.wait_for_function("() => { const t = document.querySelector('#parcelCard').innerText; return !/Checking sewer|Searching septic/.test(t); }", timeout=60000)
    card = pg.inner_text('#parcelCard')
    print(card)
    if a.apn not in card: fail.append('APN missing from card')
    if a.expect and a.expect not in card: fail.append(f'{a.expect} missing from card')
    if a.expect:
        rows = pg.evaluate("(p) => [...document.querySelectorAll('#tbl tbody tr, table tbody tr')].filter((r) => r.innerText.includes(p)).length", a.expect)
        print('table rows with', a.expect, rows)
        if not rows: fail.append(f'{a.expect} not in the results table')
    if not re.search(r'Septic records|septic', card, re.I): fail.append('septic box missing')
    if errs: fail.append('page errors: ' + '; '.join(errs))
    if a.shot: pg.screenshot(path=a.shot, full_page=True)
    b.close()
print('FAIL: ' + ' | '.join(fail) if fail else 'PASS')
sys.exit(1 if fail else 0)
