#!/usr/bin/env python3
"""Headless phone test (390x844) of 🕰 imagery history (js/history.js) near Ramona: slider shows, a 2014 Wayback release and
NAIP years load non-blank tiles, swipe compare drags and shows two different images, wells still render and open a popup,
plot plan export source follows history, imagery requests carry no app data, 0 page errors.
Usage: python3 tools/test-history.py (needs playwright + Pillow) [--base URL] [--shots DIR] [--all-naip]"""
import sys, os, http.server, threading, functools, argparse, tempfile, io
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops, ImageStat
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default=''); ap.add_argument('--all-naip', action='store_true'); a = ap.parse_args()
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
# JS: stats of loaded tiles in a pane (canvas read works because tiles are CORS-anonymous)
TILESTAT = '''(pane) => { const ims = [...document.querySelectorAll('.leaflet-' + pane + '-pane img.leaflet-tile-loaded')];
  const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'); let ok = 0, sd = [];
  for (const im of ims) { try { x.clearRect(0,0,32,32); x.drawImage(im, 0, 0, 32, 32); const d = x.getImageData(0,0,32,32).data; let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const v = (d[i]+d[i+1]+d[i+2])/3; s += v; s2 += v*v; n++; } const m = s/n, v = Math.sqrt(Math.max(0, s2/n - m*m)); sd.push(v); if (v > 6 && d[3] > 0) ok++; } catch (e) { sd.push(-1); } }
  return { n: ims.length, ok, src: ims.length ? ims[0].src : '' }; }'''
def wait_tiles(pg, pane, t=45000):
    try: pg.wait_for_function(f'() => document.querySelectorAll(".leaflet-{pane}-pane img.leaflet-tile-loaded").length >= 2 && !document.querySelector(".leaflet-{pane}-pane img.leaflet-tile:not(.leaflet-tile-loaded)")', timeout=t)
    except Exception: pass
    pg.wait_for_timeout(500); return pg.evaluate(TILESTAT, pane)
def select(pg, pred):
    """move the slider (active side) to the first timeline item matching JS predicate (x) => bool"""
    i = pg.evaluate(f'() => WellsHistory.items().findIndex({pred})')
    if i < 0: return None
    pg.evaluate(f'(i) => {{ const r = document.querySelector(".hb-range"); r.value = i; r.dispatchEvent(new Event("input")); }}', i)
    pg.wait_for_timeout(300); return pg.inner_text('.hb-date')
def shot(pg, name):
    if a.shots: os.makedirs(a.shots, exist_ok=True); pg.screenshot(path=os.path.join(a.shots, name)); print('  shot', os.path.join(a.shots, name))
with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
    ctx = p.chromium.launch_persistent_context(os.path.join(tmp, 'prof'), executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
        viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    pg = ctx.new_page(); errs, reqs = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)[:300])); pg.on('request', lambda r: reqs.append(r.url))
    pg.goto(f'{base}index.html?lat=33.0417&lon=-116.8681&r=0.5&v={os.getpid()}')
    pg.wait_for_function('window.WellsHistory && window.WellsApp', timeout=60000)
    try: pg.wait_for_function('() => document.querySelectorAll(".leaflet-marker-pane .leaflet-marker-icon, .leaflet-overlay-pane path.leaflet-interactive").length > 0', timeout=90000)
    except Exception: pass
    nW = pg.evaluate('() => document.querySelectorAll(".leaflet-marker-pane .leaflet-marker-icon, .leaflet-overlay-pane path.leaflet-interactive").length')
    check(nW > 0, f'wells render ({nW} markers) before history')
    pg.evaluate('() => WellsApp.map.setView([33.0417, -116.8681], 17, { animate: false })'); pg.wait_for_timeout(800)
    check(pg.locator('.hist-ctl .hist-btn').count() == 1, 'History button on the map')
    pg.locator('.hist-ctl .hist-btn').tap()
    pg.wait_for_function('() => WellsHistory.items().some((x) => x.src === "wb")', timeout=30000)
    check(pg.is_visible('.hist-bar .hb-range'), 'timeline slider shown')
    try: pg.wait_for_function('() => WellsHistory.changed && WellsHistory.changed.size > 0', timeout=60000)
    except Exception: pass
    allN = pg.evaluate('() => WellsHistory.items().length'); chg = pg.evaluate('() => WellsHistory.changed ? WellsHistory.changed.size : 0')
    oldest = pg.evaluate('() => WellsHistory.items().find((x) => x.src === "wb")?.date')
    check(chg > 3, f'changed-here-only: {chg} Wayback dates with new imagery here ({allN} timeline items incl. NAIP); oldest {oldest}')
    pg.uncheck('.hb-changed'); pg.wait_for_timeout(300)
    nAll = pg.evaluate('() => WellsHistory.items().filter((x) => x.src === "wb").length')
    check(nAll > chg, f'all dates: {nAll} Wayback releases > {chg} changed'); pg.check('.hb-changed'); pg.wait_for_timeout(300)
    # 2014 wayback
    lbl = select(pg, '(x) => x.src === "wb" && x.date.startsWith("2014")')
    s = wait_tiles(pg, 'histA'); check(bool(lbl) and s['ok'] >= 2 and '/tile/' in s['src'], f'2014 Wayback loads non-blank tiles: {lbl} {s["ok"]}/{s["n"]}')
    try: pg.wait_for_function('() => /Captured|n\\/a/.test(document.querySelector(".hb-meta").textContent)', timeout=20000)
    except Exception: pass
    meta = pg.inner_text('.hb-meta'); check('Captured' in meta, f'capture metadata shown: {meta!r}')
    shot(pg, 'history-wayback-2014.png')
    ex = pg.evaluate('() => { const e = WellsHistory.exportSource(); return e && { t: typeof e.tpl, c: e.credit }; }')
    check(ex and 'Wayback 2014' in ex['c'], f'plot plan export follows history: {ex}')
    years = pg.evaluate('WellsHistory.NAIP_YEARS') if a.all_naip else [2005, 2012, 2022]
    ok_years = []
    for y in years:
        lbl = select(pg, f'(x) => x.id === "naip{y}"'); s = wait_tiles(pg, 'histA')
        good = s['ok'] >= 2 and 'NAIP_' + str(y) in s['src']; check(good, f'NAIP {y} loads non-blank tiles {s["ok"]}/{s["n"]}')
        if good: ok_years.append(y)
        if y == 2005: shot(pg, 'history-naip-2005.png')
    print('NAIP years OK here:', ok_years)
    # compare: L = NAIP 2005, R = newest wayback
    pg.check('.hb-cmp'); pg.wait_for_timeout(300)
    pg.click('.hb-side[data-s="a"]'); select(pg, '(x) => x.id === "naip2005"')
    pg.click('.hb-side[data-s="b"]'); select(pg, '(x) => x.src === "wb" && x === WellsHistory.items().filter((q) => q.src === "wb").slice(-1)[0]')
    sa, sb = wait_tiles(pg, 'histA'), wait_tiles(pg, 'histB')
    check(sa['ok'] >= 2 and sb['ok'] >= 2 and sa['src'] != sb['src'], f'compare: both sides load (L {sa["ok"]}, R {sb["ok"]})')
    box = pg.locator('#map').bounding_box(); kn = pg.locator('.hist-swipe .hs-knob').bounding_box()
    check(kn is not None and abs(kn['x'] + kn['width'] / 2 - (box['x'] + box['width'] / 2)) < 30, 'divider starts mid-map')
    c0 = pg.evaluate('() => WellsApp.map.getCenter()')
    cx, cy = kn['x'] + kn['width'] / 2, kn['y'] + kn['height'] / 2
    pg.mouse.move(cx, cy); pg.mouse.down(); pg.mouse.move(cx - 60, cy, steps=5); pg.mouse.move(box['x'] + box['width'] * 0.3, cy, steps=5); pg.mouse.up()
    pg.wait_for_timeout(300)
    c1 = pg.evaluate('() => WellsApp.map.getCenter()'); dv = pg.evaluate('() => WellsHistory.state.div')
    check(abs(dv - 0.3) < 0.05 and abs(c0['lng'] - c1['lng']) < 1e-6, f'divider drags to {dv:.2f} without panning the map')
    # touch drag back via CDP touch events
    kn = pg.locator('.hist-swipe .hs-knob').bounding_box(); cx = kn['x'] + kn['width'] / 2
    cdp = ctx.new_cdp_session(pg)
    def touch(t, x): cdp.send('Input.dispatchTouchEvent', {'type': t, 'touchPoints': [] if t == 'touchEnd' else [{'x': x, 'y': cy}]})
    touch('touchStart', cx)
    for k in range(1, 8): touch('touchMove', cx + k * (box['width'] * 0.3) / 7)
    touch('touchEnd', 0); pg.wait_for_timeout(300)
    dv2 = pg.evaluate('() => WellsHistory.state.div'); check(abs(dv2 - 0.6) < 0.06, f'divider drags by touch to {dv2:.2f}')
    m = pg.locator('#map').screenshot(); im = Image.open(io.BytesIO(m)).convert('L'); W, H = im.size
    # left of divider = NAIP 2005, right = latest Wayback; compare each against the other source alone at the same spot
    pg.uncheck('.hb-cmp'); wait_tiles(pg, 'histA'); only_a = Image.open(io.BytesIO(pg.locator('#map').screenshot())).convert('L')
    rbox = (int(W * 0.7), int(H * 0.1), int(W * 0.95), int(H * 0.5)); lbox = (int(W * 0.05), int(H * 0.1), int(W * 0.5), int(H * 0.5))
    dR = ImageStat.Stat(ImageChops.difference(im.crop(rbox), only_a.crop(rbox))).mean[0]; dL = ImageStat.Stat(ImageChops.difference(im.crop(lbox), only_a.crop(lbox))).mean[0]
    check(dR > 8 and dL < dR / 2, f'swipe shows two different images (right side differs by {dR:.1f}, left by {dL:.1f})')
    pg.check('.hb-cmp'); wait_tiles(pg, 'histB'); shot(pg, 'history-swipe-compare.png')
    # wells still tap through history (zoom out so markers are in view)
    pg.evaluate('() => WellsApp.map.setView([33.0417, -116.8681], 15, { animate: false })'); pg.wait_for_timeout(1500)
    mk = pg.locator('.leaflet-marker-pane .leaflet-marker-icon')
    vis = [i for i in range(min(mk.count(), 60)) if (lambda b: b and box['y'] + 60 < b['y'] < box['y'] + box['height'] * 0.55 and box['x'] + 10 < b['x'] < box['x'] + box['width'] * 0.45)(mk.nth(i).bounding_box())]
    if vis:
        b = mk.nth(vis[0]).bounding_box(); pg.touchscreen.tap(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
        try: pg.wait_for_selector('.leaflet-popup-content', timeout=8000)
        except Exception: pass
    else:
        pv = pg.evaluate('() => { const l = document.querySelector(".leaflet-overlay-pane path.leaflet-interactive"); if (!l) return false; l.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }'); pg.wait_for_timeout(800)
    check(pg.locator('.leaflet-popup-content').count() > 0, f'well marker taps open a popup with history on ({len(vis)} markers in view)')
    # plot plan export with a past image (NAIP 2005 on the left/only side): tiles must draw (CORS) and the credit must say so
    pg.uncheck('.hb-cmp'); pg.click('.hb-side[data-s="a"]') if pg.is_visible('.hb-side[data-s="a"]') else None
    select(pg, '(x) => x.id === "naip2005"')
    for want in ('naip2005', 'wb2014'):
        if want == 'wb2014': select(pg, '(x) => x.src === "wb" && x.date.startsWith("2014")')
        r = pg.evaluate("""async () => { const l = LayoutCore.newLayout({ name: 'Synthetic test', view: { lat: 33.0417, lon: -116.8681, z: 19 } });
            const { canvas, info } = await WellsLayout.renderPlan(l, { dpi: 72 }); canvas.toDataURL(); return { tiles: info.tiles, ok: info.tilesOk, credit: WellsHistory.exportSource().credit }; }""")
        check(r['tiles'] > 0 and r['ok'] >= r['tiles'] * 0.9 and ('2005' in r['credit'] if want == 'naip2005' else '2014' in r['credit']), f'plot plan export with {want}: {r["ok"]}/{r["tiles"]} tiles, canvas exportable, credit {r["credit"]!r}')
    pg.locator('.hb-x').tap(); pg.wait_for_timeout(300)
    check(not pg.is_visible('.hist-bar') and pg.evaluate('() => !WellsHistory.exportSource()'), 'closing history: bar hidden, export back to current imagery')
    img_hosts = [u for u in reqs if 'wayback' in u or 'wildlife.ca.gov' in u or 'metadata.maptiles' in u]
    leak = [u for u in img_hosts if any(k in u.lower() for k in ('apn', 'job', 'site', 'address', 'name='))]
    check(img_hosts and not leak, f'{len(img_hosts)} imagery requests, none carry app data')
    check(not errs, f'0 page errors {errs[:3]}')
    ctx.close()
print('\nALL PASS' if not fails else f'\n{len(fails)} FAIL'); sys.exit(1 if fails else 0)
