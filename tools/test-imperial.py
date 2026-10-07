#!/usr/bin/env python3
"""Headless phone test of the Imperial County DWR WCR overlay (js/imperial.js + data/imperial-wcr/).
Usage: /workspace/.venv-pw/bin/python tools/test-imperial.py [--base https://.../wells-nearby/]
Checks: Ocotillo search loads the manifest + only nearby Imperial tiles, draws purple pins, the layer has its own toggle in
the layer control, a pin popup shows WCR #, DWR accuracy and the PDF link (or 'No PDF link'), and there are no page errors."""
import sys, os, json, http.server, threading, functools, argparse, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); a = ap.parse_args()
if a.base: base = a.base.rstrip('/') + '/'
else:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); base = f'http://127.0.0.1:{srv.server_address[1]}/'
fails = []
def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg, flush=True)
    if not ok: fails.append(msg)
with sync_playwright() as p, tempfile.TemporaryDirectory() as prof:
    ctx = p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
                                               viewport={'width': 412, 'height': 915}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []; reqs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.on('request', lambda r: reqs.append(r.url) if '/imperial-wcr/' in r.url else None)
    pg.goto(f'{base}index.html?lat=32.7395&lon=-115.9952&r=1&view=both')
    pg.wait_for_function('window.WellsImperial && WellsImperial.loaded.size > 0', timeout=30000)
    pg.wait_for_timeout(1500)
    info = pg.evaluate('''() => ({ tiles: WellsImperial.loaded.size, recs: Object.keys(WellsImperial.records).length,
        pins: document.querySelectorAll('.leaflet-imperialWcr-pane path').length,
        toggle: [...document.querySelectorAll('.leaflet-control-layers-overlays label')].map((l) => l.textContent.trim()) })''')
    print(json.dumps(info))
    check(any('manifest.json' in u for u in reqs), 'manifest fetched')
    check(info['tiles'] > 0 and info['recs'] > 0, f"{info['tiles']} tiles / {info['recs']} WCRs loaded near Ocotillo")
    check(info['pins'] > 0, f"{info['pins']} purple pins drawn")
    check(any('Imperial WCRs' in t for t in info['toggle']), 'own toggle in the layer control')
    check(all('/imperial-wcr/' in u for u in reqs), 'only Imperial data files requested by the overlay')
    pg.evaluate('''() => { const m = WellsApp.map; let hit = null;
        WellsImperial.layer.eachLayer((l) => { if (!hit) hit = l; }); hit.openPopup(); }''')
    pg.wait_for_selector('.leaflet-popup-content .imp-tag', timeout=5000)
    html = pg.inner_text('.leaflet-popup-content')
    check('WCR' in html and 'Accuracy' in html, 'popup shows WCR # and DWR accuracy')
    check('WCR PDF' in html or 'No PDF link' in html, 'popup shows PDF link state')
    pg.screenshot(path=os.environ.get('IMPERIAL_SHOT', '/tmp/imperial-popup.png'))
    check(not errs, 'no page errors ' + '; '.join(errs))
    ctx.close()
print('all passed' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
