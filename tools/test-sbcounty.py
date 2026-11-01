#!/usr/bin/env python3
"""Headless test of the San Bernardino overlays (js/sbcounty.js: data/sb-oswcr + data/sbcounty-permits).
Usage: /workspace/.venv-pw/bin/python tools/test-sbcounty.py [--base URL] [--shots DIR]
Phone 390x844 (touch) + desktop 1440x900 at Phelan (permit 2026100458): WCR pins drawn, permit square drawn, popups open
(permit shows APN parcel-centre wording; a WCR shows the DWR fields), the three toggles exist, other counties' overlays still
load (SD / LA / Imperial objects present), no page errors."""
import os, json, http.server, threading, functools, argparse, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default=os.path.join(ROOT, 'screenshots', 'sbcounty'))
a = ap.parse_args(); os.makedirs(a.shots, exist_ok=True)
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
LAT, LON = 34.538367, -117.545285
with sync_playwright() as p:
    for name, vp, mob in (('phone', {'width': 390, 'height': 844}, True), ('desktop', {'width': 1440, 'height': 900}, False)):
        with tempfile.TemporaryDirectory() as prof:
            ctx = p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
                                                       viewport=vp, is_mobile=mob, has_touch=mob)
            pg = ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
            pg.goto(f'{base}index.html?lat={LAT}&lon={LON}&r=1&view=both')
            pg.wait_for_function('window.WellsSbCounty && WellsSbCounty.drawn.main.size > 0 && WellsSbCounty.permitLayer.getLayers().length > 0', timeout=45000)
            pg.wait_for_timeout(2500)
            info = pg.evaluate('''() => ({ tiles: WellsSbCounty.drawn.main.size, wcrs: WellsSbCounty.layer.getLayers().length,
              permits: WellsSbCounty.permitLayer.getLayers().length, squares: document.querySelectorAll('.sbp-icon').length,
              toggles: [...document.querySelectorAll('.leaflet-control-layers-overlays label')].map((l) => l.textContent.trim()).filter((t) => /SB County/.test(t)),
              others: !!(window.WellsSdOswcr && window.WellsLaWcr && window.WellsImperial) })''')
            print(name, json.dumps(info))
            check(info['wcrs'] > 0, f'{name}: {info["wcrs"]} SB WCR pins near Phelan')
            check(info['permits'] >= 18 and info['squares'] > 0, f'{name}: {info["permits"]} permits loaded, {info["squares"]} squares in DOM')
            check(len(info['toggles']) == 3, f'{name}: 3 SB toggles')
            check(info['others'], f'{name}: SD / LA / Imperial overlays still initialised')
            pg.locator('#map').scroll_into_view_if_needed(); pg.locator('#map').screenshot(path=os.path.join(a.shots, f'{name}-map.png'))
            pg.evaluate('''() => { let hit; WellsSbCounty.permitLayer.eachLayer((l) => { if (/2026100458/.test(l.options.title)) hit = l; }); WellsApp.map.setView(hit.getLatLng(), 16); setTimeout(() => hit.openPopup(), 600); }''')
            pg.wait_for_selector('.leaflet-popup-content .sbo-tag.p', timeout=8000); pg.wait_for_timeout(800)
            txt = pg.inner_text('.leaflet-popup-content')
            check('2026100458' in txt and 'Parcel centre of APN 3130-471-03-0000' in txt, f'{name}: permit popup with APN parcel centre')
            pg.locator('#map').scroll_into_view_if_needed(); pg.locator('#map').screenshot(path=os.path.join(a.shots, f'{name}-permit-popup.png'))
            pg.evaluate('''() => { WellsApp.map.closePopup(); let hit; WellsSbCounty.layer.eachLayer((l) => { if (!hit) hit = l; }); WellsApp.map.setView(hit.getLatLng(), 15); setTimeout(() => hit.openPopup(), 600); }''')
            pg.wait_for_selector('.leaflet-popup-content .sbo-tag', timeout=8000); pg.wait_for_timeout(800)
            txt = pg.inner_text('.leaflet-popup-content')
            check('San Bernardino' in txt and 'WCR' in txt, f'{name}: WCR popup')
            pg.locator('#map').scroll_into_view_if_needed(); pg.locator('#map').screenshot(path=os.path.join(a.shots, f'{name}-wcr-popup.png'))
            check(not errs, f'{name}: no page errors {errs}')
            ctx.close()
print('ALL PASS' if not fails else f'{len(fails)} FAIL')
raise SystemExit(1 if fails else 0)
