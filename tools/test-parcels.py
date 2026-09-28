#!/usr/bin/env python3
"""Headless phone test of the property-lines layer (js/parcels.js).
Usage: /workspace/.venv-pw/bin/python tools/test-parcels.py [--base URL] [--shot /workspace/parcels-shot.png]"""
import sys, os, http.server, threading, functools, argparse, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shot', default='/workspace/parcels-shot.png'); a = ap.parse_args()
srv = None
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
LAT, LON = 33.0417, -116.8681
TILES = '''() => { const imgs = [...document.querySelectorAll('.leaflet-parcels-pane img.leaflet-tile')];
  return {n: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length, labels: imgs.filter(i => /show:0,1/.test(i.src)).length,
          opacity: (document.querySelector('.leaflet-parcels-pane .leaflet-layer') || {style: {}}).style.opacity}; }'''
with sync_playwright() as p, tempfile.TemporaryDirectory() as prof:
    ctx = p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', args=['--no-sandbox'], viewport={'width': 412, 'height': 915},
                                               is_mobile=True, has_touch=True, device_scale_factor=2)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.goto(f'{base}index.html?lat={LAT}&lon={LON}&r=0.25&view=both')
    pg.wait_for_selector('#summary:not(.hidden)', timeout=90000); pg.wait_for_timeout(1500)
    pins0 = pg.locator('.well-pin').count()
    check(pg.locator('.parcel-ctl .pc-btn').is_visible(), 'Lines button visible on the map (top-left)')
    check(not pg.locator('.parcel-ctl .pc-panel').is_visible(), 'opacity panel hidden while off')
    pg.evaluate(f'() => WellsApp.map.setView([{LAT}, {LON}], 13, {{animate: false}})'); pg.wait_for_timeout(500)
    pg.locator('.parcel-ctl .pc-btn').tap(); pg.wait_for_timeout(2500)
    t = pg.evaluate(TILES)
    check(t['n'] == 0 and 'Zoom in' in pg.inner_text('.parcel-ctl .pc-hint'), f'zoom 13: no parcel tiles, "zoom in" hint ({t})')
    for z in (15, 16, 17, 18):
        pg.evaluate(f'() => WellsApp.map.setView([{LAT}, {LON}], {z}, {{animate: false}})')
        try: pg.wait_for_function('() => { const i = [...document.querySelectorAll(".leaflet-parcels-pane img.leaflet-tile")]; return i.length && i.every(x => x.complete); }', timeout=45000)
        except Exception: pass
        pg.wait_for_timeout(800); t = pg.evaluate(TILES)
        check(t['loaded'] > 0 and t['loaded'] == t['n'] and (t['labels'] > 0) == (z >= 18), f'zoom {z}: {t["loaded"]}/{t["n"]} parcel tiles loaded, APN labels {"on" if t["labels"] else "off"}')
        pg.locator('#map').screenshot(path=f'/tmp/parcels-z{z}.png')
    # opacity via the slider
    for op in (0, 30, 100, 60):
        pg.evaluate(f"() => {{ const r = document.querySelector('.parcel-ctl .pc-range'); r.value = '{op}'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }}")
        pg.wait_for_timeout(300); t = pg.evaluate(TILES)
        check(abs(float(t['opacity'] or 1) - op / 100) < 1e-6 and pg.inner_text('.parcel-ctl .pc-val') == f'{op}%', f'opacity {op}% applied ({t["opacity"]})')
    pg.evaluate(f'() => WellsApp.map.setView([33.0435, -116.8700], 17, {{animate: false}})')
    pg.wait_for_function('() => { const i = [...document.querySelectorAll(".leaflet-parcels-pane img.leaflet-tile")]; return i.length && i.every(x => x.complete); }', timeout=45000)
    pg.wait_for_timeout(2500)
    pg.locator('#map').scroll_into_view_if_needed(); pg.wait_for_timeout(500)
    pg.locator('#map').screenshot(path=a.shot)
    print('screenshot:', a.shot)
    # tap -> APN
    box = pg.locator('#map').bounding_box()
    pt = pg.evaluate('() => WellsApp.map.latLngToContainerPoint([33.04305, -116.86973])')  # inside parcel 281-262-15-00
    pg.mouse.click(box['x'] + pt['x'], box['y'] + pt['y'])
    try: pg.wait_for_selector('.leaflet-popup .pc-apn', timeout=20000); apn = pg.inner_text('.leaflet-popup-content').replace(chr(10), ' ')
    except Exception: apn = ''
    check('APN' in apn and pg.locator('.leaflet-popup #searchHere').count() == 1, f'tap at zoom 17 shows parcel APN in the tap popup, "Search here" kept ({apn!r})')
    pg.locator('#map').screenshot(path='/tmp/parcels-tap.png')
    check(pg.locator('.well-pin').count() > 0 and pins0 > 0, f'well pins still drawn ({pins0} before)')
    # persistence
    pg.reload(); pg.wait_for_selector('#summary:not(.hidden)', timeout=90000); pg.wait_for_timeout(1000)
    s = pg.evaluate('() => WellsParcels.state')
    check(s == {'on': True, 'opacity': 60} and pg.locator('.parcel-ctl.on').count() == 1, f'on/off + opacity remembered after reload ({s})')
    pg.locator('.parcel-ctl .pc-btn').tap(); pg.wait_for_timeout(500)
    pg.reload(); pg.wait_for_selector('#summary:not(.hidden)', timeout=90000); pg.wait_for_timeout(800)
    t = pg.evaluate(TILES)
    check(pg.evaluate('() => WellsParcels.state.on') is False and t['n'] == 0, 'turned off -> stays off after reload, no tiles')
    check(not errs, 'no page errors' + (f': {errs[:3]}' if errs else ''))
    ctx.close()
if srv: srv.shutdown()
print('ALL PASS' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
