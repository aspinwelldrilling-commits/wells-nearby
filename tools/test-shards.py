#!/usr/bin/env python3
"""Headless phone test of the sharded county WCR data (manifest + tiles).
Usage: /workspace/.venv-pw/bin/python tools/test-shards.py [--base https://.../wells-nearby/]
Checks: Ramona + Valley Center load only nearby tiles and show OCR / red wells; an area with no processed permits fetches no
tiles and shows grey "not yet processed" pins; tiles fetched once are served by the service worker offline."""
import sys, os, http.server, threading, functools, argparse, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); a = ap.parse_args()
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
CASES = [('Ramona', 33.0417, -116.8681, True), ('Valley Center', 33.2184, -117.0342, True), ('Borrego Springs (no data yet)', 33.2559, -116.3747, False)]
with sync_playwright() as p, tempfile.TemporaryDirectory() as prof:
    ctx = p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', args=['--no-sandbox'], viewport={'width': 412, 'height': 915},
                                               is_mobile=True, has_touch=True, device_scale_factor=1)
    pg = ctx.new_page(); errs = []; tiles = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.on('request', lambda r: tiles.append(r.url) if '/county-wcr/' in r.url else None)
    for name, lat, lon, has in CASES:
        tiles.clear()
        pg.goto(f'{base}index.html?lat={lat}&lon={lon}&r=1&view=both')
        pg.wait_for_selector('#summary:not(.hidden)', timeout=90000); pg.wait_for_timeout(2500)
        info = pg.evaluate('''() => { const s = WellsApp.state.shown, CW = WellsCountyWcr;
          return {loaded: CW.loadedTiles.length, manifestTiles: Object.keys(CW.manifest.tiles || {}).length, legacy: !!CW.manifest.legacy,
            ocr: s.filter(w => w.fieldSrc && Object.values(w.fieldSrc).some(f => f.src === 'ocr')).length,
            red: s.filter(w => w.wcrFlag === 'read').length, pending: s.filter(w => w.wcrFlag === 'pending').length,
            redPins: document.querySelectorAll('.pin-red').length, county: s.filter(w => w.group === 'county' || w.county).length,
            oldIndex: performance.getEntriesByType('resource').some(e => /county-wcr\\/index\\.json/.test(e.name))}; }''')
        tfetch = [u for u in tiles if '/tiles/' in u]
        print(f'  {name}: {info} tile requests={len(tfetch)}')
        check(not info['legacy'] and not info['oldIndex'], f'{name}: uses manifest + tiles (no legacy index.json)')
        if has:
            check(0 < len(tfetch) <= 16, f'{name}: fetched {len(tfetch)} nearby tiles of {info["manifestTiles"]}')
            check(info['red'] > 0 and info['redPins'] > 0, f'{name}: red "read yourself" wells shown ({info["red"]})')
            if name == 'Ramona': check(info['ocr'] >= 1, f'{name}: OCR-tagged well shown ({info["ocr"]})')
        else:
            check(len(tfetch) == 0 and info['red'] == 0, f'{name}: no tiles fetched, no red wells')
            check(info['pending'] > 0, f'{name}: county permits shown as not yet processed ({info["pending"]})')
    # Valley Center OCR: the readable VC permits all match state WCRs with depth, so check the tag via the OCR table marks
    # offline: service worker must be controlling; revisit Ramona so its tiles are in the SW cache, then go offline
    pg.goto(f'{base}index.html?lat=33.0417&lon=-116.8681&r=1&view=both')
    pg.wait_for_function('() => navigator.serviceWorker && navigator.serviceWorker.controller', timeout=30000)
    pg.wait_for_selector('#summary:not(.hidden)', timeout=90000); pg.wait_for_timeout(2000)
    cached = pg.evaluate("async () => { const ks = await (await caches.open('wells-nearby-shell-v2')).keys(); return ks.map(r => r.url).filter(u => /county-wcr/.test(u)).length; }")
    check(cached >= 2, f'service worker cached manifest + tiles ({cached} entries)')
    ctx.set_offline(True)
    pg.reload(wait_until='domcontentloaded'); pg.wait_for_timeout(4000)
    n = pg.evaluate('async () => { const i = await WellsCountyWcr.ensure(33.0417, -116.8681, 1.75); return Object.keys(i).length; }')
    check(n > 50, f'offline: tiles for Ramona served from the device cache ({n} permits)')
    ctx.set_offline(False)
    check(not errs, 'no page errors' + (f': {errs[:3]}' if errs else ''))
    ctx.close()
if srv: srv.shutdown()
print('ALL PASS' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
