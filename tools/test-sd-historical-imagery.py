#!/usr/bin/env python3
"""San Diego County historical aerials on the 🕰 history slider (js/history.js): the County years (1995 B&W, 1997/2000/2002
colour infrared, 2004/2006/2008/2011) appear on the slider in date order with their labels, one Ramona export tile per year
answers HTTP 200 image, the tiles draw on the map, and outside the County the bar says there is no County imagery.
Usage: python3 tools/test-sd-historical-imagery.py [--base URL] [--shots DIR --prefix after-] [--desktop]"""
import sys, os, http.server, threading, functools, argparse, tempfile
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default=''); ap.add_argument('--prefix', default='')
ap.add_argument('--desktop', action='store_true'); a = ap.parse_args()
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
dev = 'desktop' if a.desktop else 'phone'
def shot(pg, name):
    if a.shots: os.makedirs(a.shots, exist_ok=True); f = os.path.join(a.shots, f'{a.prefix}{dev}-{name}.png'); pg.screenshot(path=f); print('  shot', f)
EXP = {1995: '(B&W)', 1997: '(color infrared)', 2000: '(color infrared)', 2002: '(color infrared)', 2004: '', 2006: '', 2008: '', 2011: ''}
with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
    vp = {'width': 1920, 'height': 1080} if a.desktop else {'width': 390, 'height': 844}
    ctx = p.chromium.launch_persistent_context(os.path.join(tmp, 'prof'), executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
        viewport=vp, is_mobile=not a.desktop, has_touch=not a.desktop, device_scale_factor=1 if a.desktop else 2)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
    pg.goto(f'{base}index.html?lat=33.0416&lon=-116.8670&r=0.5&v={os.getpid()}')
    pg.wait_for_function('window.WellsHistory && window.WellsApp', timeout=60000)
    pg.evaluate('() => WellsApp.map.setView([33.0416, -116.8670], 17, { animate: false })'); pg.wait_for_timeout(2500); pg.evaluate("() => WellsApp.map.setView([33.0416, -116.8670], 17, { animate: false })"); pg.wait_for_timeout(800)
    pg.locator('.hist-ctl .hist-btn').click()
    try: pg.wait_for_function('() => WellsHistory.items().some((x) => x.src === "wb")', timeout=30000)
    except Exception: pass
    if pg.is_checked('.hb-changed'): pg.uncheck('.hb-changed'); pg.wait_for_timeout(400)
    its = pg.evaluate('() => WellsHistory.items().map((x) => [x.src, x.year || 0, x.date])')
    dates = [d for _, _, d in its]
    check(dates == sorted(dates), f'slider in date order ({len(its)} items)')
    sd = [y for s, y, _ in its if s == 'sd']
    check(sd == sorted(EXP), f'County years on slider: {sd}')
    check(any(s == 'naip' and y == 2022 for s, y, _ in its) and any(s == 'naip' and y == 2005 for s, y, _ in its), 'NAIP years still on slider')
    check(its[0][0] == 'sd' and its[0][1] == 1995, 'oldest slider item is 1995 County B&W')
    for y, tag in EXP.items():
        i = pg.evaluate(f'() => WellsHistory.items().findIndex((x) => x.id === "sd{y}")')
        pg.evaluate('(i) => { const r = document.querySelector(".hb-range"); r.value = i; r.dispatchEvent(new Event("input")); }', i)
        lab = pg.inner_text('.hb-date')
        check(str(y) in lab and tag in lab, f'{y} label "{lab}"')
        try: pg.wait_for_function('() => document.querySelectorAll(".leaflet-histA-pane img.leaflet-tile-loaded").length >= 2 && !document.querySelector(".leaflet-histA-pane img.leaflet-tile:not(.leaflet-tile-loaded)")', timeout=45000)
        except Exception: pass
        pg.wait_for_timeout(600)
        n = pg.evaluate('() => document.querySelectorAll(".leaflet-histA-pane img.leaflet-tile-loaded").length')
        src = pg.evaluate('() => document.querySelector(".leaflet-histA-pane img.leaflet-tile")?.src || ""')
        r = pg.evaluate('async (u) => { try { const q = await fetch(u); const b = await q.blob(); return [q.status, q.headers.get("content-type"), b.size]; } catch (e) { return [0, String(e), 0]; } }', src)
        blank = pg.evaluate('''() => [...document.querySelectorAll(".leaflet-histA-pane img.leaflet-tile-loaded")].filter((im) => { const c = document.createElement("canvas"); c.width = c.height = 16; const x = c.getContext("2d"); x.drawImage(im, 0, 0, 16, 16); const d = x.getImageData(0, 0, 16, 16).data; let s = 0, s2 = 0; for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i+1] + d[i+2]) / 3; s += v; s2 += v * v; } const m = s / 64 / 4 * 4 / 4; return Math.sqrt(Math.max(0, s2 / 256 - (s / 256) ** 2)) < 3; }).length''')
        check(n >= 2 and blank == 0, f'{y} tiles drawn with picture ({n} tiles, {blank} blank) at zoom {pg.evaluate("() => WellsApp.map.getZoom()")}')
        check(r[0] == 200 and 'image' in (r[1] or '') and r[2] > 5000, f'{y} Ramona tile HTTP {r[0]} {r[1]} {r[2]} B; {n} tiles drawn')
        check('San Diego County' in pg.inner_text('.leaflet-control-attribution'), f'{y} attribution San Diego County')
        shot(pg, f'ramona-{y}')
    pg.evaluate('() => WellsApp.map.setZoom(13, { animate: false })'); pg.wait_for_timeout(1500)
    check('Zoom in' in pg.inner_text('.hb-meta'), 'zoomed out: asks to zoom in for County imagery')
    # outside the County (Temecula, Riverside County)
    pg.evaluate('() => WellsApp.map.setView([33.55, -117.15], 15, { animate: false })'); pg.wait_for_timeout(2500)
    meta = pg.inner_text('.hb-meta')
    check('No County imagery' in meta, f'outside County note: "{meta}"')
    shot(pg, 'outside-2011')
    check(not errs, f'no page errors {errs[:2]}')
    ctx.close()
print('ALL PASS' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
