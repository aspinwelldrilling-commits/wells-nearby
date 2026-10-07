#!/usr/bin/env python3
"""Headless test of the map's address / APN search box (js/search.js) across San Diego, Riverside and Imperial County.
Usage: /workspace/.venv-pw/bin/python tools/test-address-search.py [--base https://.../wells-nearby/]
Each case types into the box, submits, picks the first candidate if a pick list shows, and checks where the search point
(WellsApp.state) landed: inside the expected county box and, where given, within a distance of a known point."""
import os, math, http.server, threading, functools, argparse, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); a = ap.parse_args()
if a.base: base = a.base.rstrip('/') + '/'
else:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); base = f'http://127.0.0.1:{srv.server_address[1]}/'
BOX = {'sd': (32.52, -117.62, 33.51, -116.08), 'imperial': (32.61, -116.11, 33.44, -114.46), 'riverside': (33.42, -117.68, 34.08, -114.43)}
def km(p, q):
    r = math.radians; dl = r(q[0] - p[0]); dn = r(q[1] - p[1])
    h = math.sin(dl / 2) ** 2 + math.cos(r(p[0])) * math.cos(r(q[0])) * math.sin(dn / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))
# (query, county, near point or None, max km, text expected in the search-point label or None)
CASES = [
    ('285-030-06-00', 'sd', None, 0, 'APN 285-030-06-00'),
    ('2850300600', 'sd', None, 0, 'APN 285-030-06-00'),
    ('Ocotillo Wells', 'sd', (33.1456, -116.1347), 3, None),
    ('Ocotillo', 'imperial', (32.74, -115.99), 2, None),
    ('92259', 'imperial', (32.74, -115.99), 2, None),
    ('600 E Main St, El Centro', 'imperial', (32.7929, -115.5335), 0.5, 'EL CENTRO'),
    ('1025 River Dr, Brawley 92227', 'imperial', (32.9865, -115.525), 0.5, 'BRAWLEY'),
    ('333 E Barioni Blvd, Imperial', 'imperial', (32.848, -115.5666), 0.5, None),
    ('047-060-003', 'imperial', (32.9865, -115.525), 0.5, 'APN 047-060-003'),
    ('047-060-003-000', 'imperial', (32.9865, -115.525), 0.5, 'APN 047-060-003'),
    ('049-081-25-01', 'imperial', None, 0, 'APN 049-081-025'),
    ('584-040-003', 'riverside', None, 0, 'APN 584-040-003'),
    ('729 Main St, Ramona', 'sd', (33.0417, -116.8681), 1.5, 'RAMONA'),
    ('1025 River Dr, Brawley', 'imperial', (32.9865, -115.525), 0.5, 'BRAWLEY'),
    ('600 E Main St 92243', 'imperial', (32.7929, -115.5335), 0.5, 'EL CENTRO'),
    ('Brawley', 'imperial', (32.979, -115.530), 2, None),
    ('Imperial Beach', 'sd', (32.58, -117.11), 6, None),
]
fails = []
def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg, flush=True)
    if not ok: fails.append(msg)
with sync_playwright() as p, tempfile.TemporaryDirectory() as prof:
    ctx = p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
                                               viewport={'width': 412, 'height': 915}, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
    pg.goto(f'{base}index.html?lat=33.0417&lon=-116.8681&r=0.25&view=both')
    pg.wait_for_function('window.WellsSearch && window.WellsApp', timeout=30000)
    for q, county, near, maxkm, labeltxt in CASES:
        pg.evaluate("() => { WellsApp.state.lat = 0; WellsApp.state.lon = 0; WellsApp.state.how = ''; }")
        inp = pg.locator('.as-input'); inp.fill(q); inp.press('Enter')
        try:
            pg.wait_for_function("() => WellsApp.state.lat !== 0 || document.querySelector('.as-drop .as-pick, .as-drop .as-msg.warn, .as-drop .as-msg.err') && !document.querySelector('.as-go').disabled", timeout=30000)
        except Exception: pass
        picked = ''
        if pg.evaluate('WellsApp.state.lat') == 0 and pg.locator('.as-drop .as-row[data-c] .as-pick').count():
            rows = pg.locator('.as-drop .as-row[data-c] .as-pick')
            picked = f" (pick list of {rows.count()}: {' | '.join(rows.nth(i).inner_text().replace(chr(10), ' ') for i in range(min(rows.count(), 4)))})"
            rows.first.click(); pg.wait_for_timeout(300)
        st = pg.evaluate('({lat: WellsApp.state.lat, lon: WellsApp.state.lon, how: WellsApp.state.how})')
        msg = pg.evaluate("(document.querySelector('.as-drop .as-msg') || {}).innerText || ''")
        if st['lat'] == 0:
            check(False, f'{q!r}: no location set. {msg}{picked}'); continue
        b = BOX[county]; inb = b[0] <= st['lat'] <= b[2] and b[1] <= st['lon'] <= b[3]
        d = km((st['lat'], st['lon']), near) if near else None
        ok = inb and (d is None or d <= maxkm) and (not labeltxt or labeltxt in (st['how'] or '').upper())
        check(ok, f"{q!r} -> {st['lat']:.5f},{st['lon']:.5f} [{county} box: {inb}]" + (f' {d:.2f} km from {near}' if d is not None else '') + f" · {st['how']}{picked}")
    check(not errs, f'no page errors {errs[:3]}')
    ctx.close()
print(f"\n{len(CASES) + 1 - len(fails)}/{len(CASES) + 1} passed" + (f"; FAILED: {fails}" if fails else ''))
raise SystemExit(1 if fails else 0)
