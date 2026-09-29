"""Regression test for the map-tap "Search here" button (desktop mouse 1440x900 and phone touch 390x844).
Root cause it guards: the handler was bound by id in a setTimeout, so with a popup already open (Leaflet keeps the old
popup in the DOM for its 200 ms fade-out) it went to the OLD button and the visible one did nothing.
Checks: first tap, re-tap while a popup is open, close (x) then quick re-tap, Lines on at zoom 17 (APN added),
double press, after setbacks (Done / closed another way / stale map-tool flag), offline -> "No signal" + Retry,
county server failing -> error + Retry, no page errors.
Usage: python tools/test-search-here.py [--base URL] [--only desktop|phone]"""
import sys, os, re, time, http.server, threading, functools, argparse
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base'); ap.add_argument('--only'); a = ap.parse_args()
base = a.base
if not base:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_address[1]}/'
fail = []
def check(ok, msg, dev):
    print(('ok   ' if ok else 'FAIL ') + f'[{dev}] {msg}', flush=True)
    if not ok: fail.append(f'[{dev}] {msg}')

def run(pw, dev):
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    touch = dev == 'phone'
    ctx = br.new_context(viewport={'width': 390, 'height': 844} if touch else {'width': 1440, 'height': 900},
                         is_mobile=touch, has_touch=touch, device_scale_factor=2 if touch else 1)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(base + '?lat=33.0417&lon=-116.8681&r=0.25&view=both', wait_until='load')
    pg.wait_for_function("() => /State:|failed/.test(document.querySelector('#status').innerText)", timeout=90000)
    pg.locator('#map').scroll_into_view_if_needed(); time.sleep(0.8)
    def box(): return pg.locator('#map').bounding_box()
    def hit(x, y):
        if touch: pg.touchscreen.tap(x, y)
        else: pg.mouse.click(x, y)
    SPOTS = [(fx / 20, fy / 20) for fy in range(6, 17) for fx in range(3, 18)]
    def empty(fx, fy):   # not on a well pin / marker / control, so the tap reaches the map
        b = box(); x, y = b['x'] + b['width'] * fx, b['y'] + b['height'] * fy
        # a margin around the point too: phone browsers retarget a tap to a nearby tappable pin (touch adjustment)
        return pg.evaluate("""([x,y]) => { for (const dx of [-28,0,28]) for (const dy of [-28,0,28]) { const e = document.elementFromPoint(x+dx,y+dy);
            if (!e || !e.closest('#map') || e.closest('.leaflet-marker-icon,.leaflet-interactive,.leaflet-control,.leaflet-popup')) return false; } return true }""", [x, y])
    def settle():   # page scroll (sheet closing) and map pan/zoom animations finished
        prev = None
        for _ in range(30):
            cur = (box()['y'], pg.evaluate("(() => { const c = WellsApp.map.getCenter(); return WellsApp.map.getZoom() + ',' + c.lat.toFixed(7) + ',' + c.lng.toFixed(7) })()"))
            if cur == prev: return
            prev = cur; time.sleep(0.15)
    def tap(fx, fy):
        settle()
        # nearest empty spot to the requested one
        for dfx, dfy in sorted(SPOTS, key=lambda s: (s[0] - fx) ** 2 + (s[1] - fy) ** 2):
            if empty(dfx, dfy): fx, fy = dfx, dfy; break
        b = box(); hit(b['x'] + b['width'] * fx, b['y'] + b['height'] * fy)
    def press(n=1):
        if not pg.locator('.leaflet-popup .search-here').count(): return False
        b = pg.locator('.leaflet-popup .search-here').last.bounding_box(); x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        top = pg.evaluate("([x,y]) => { const e = document.elementFromPoint(x,y); return !!(e && e.closest('.search-here')) }", [x, y])
        if not top: print('   covered at', x, y, 'by', pg.evaluate("([x,y]) => { const e = document.elementFromPoint(x,y); return e ? e.outerHTML.slice(0,160) : 'nothing (off screen)' }", [x, y]), 'map class', pg.evaluate("document.getElementById('map').className"), 'top pe', pg.evaluate("getComputedStyle(document.querySelector('.leaflet-top')).pointerEvents"))
        for _ in range(n): hit(x, y); time.sleep(0.05)
        return top
    def searched_at(fn, name):
        pg.evaluate('WellsApp.map.closePopup()'); time.sleep(0.4)
        pg.locator('#map').scroll_into_view_if_needed(); time.sleep(0.2)
        r0 = pg.evaluate('WellsApp.state.reqId'); lat0 = pg.evaluate('WellsApp.state.lat')
        top = fn(); time.sleep(0.5)
        if top is False: print('   no popup; mapTool=', pg.evaluate('WellsApp.state.mapTool'), 'popups=', pg.locator('.leaflet-popup').count(), pg.evaluate("[...document.querySelectorAll('.leaflet-popup')].map(p=>p.innerText.slice(0,60))"))
        r1 = pg.evaluate('WellsApp.state.reqId'); lat1 = pg.evaluate('WellsApp.state.lat')
        check(top is not False and r1 > r0 and lat1 != lat0, f'{name}: button on top={top}, search ran ({r1 - r0}), moved={lat1 != lat0}', dev)
        pg.wait_for_function("() => !WellsApp.state.searching", timeout=90000)
    searched_at(lambda: (tap(.5, .62), time.sleep(.5), press())[2], 'first tap')
    searched_at(lambda: (tap(.5, .62), time.sleep(.5), tap(.3, .7), time.sleep(.5), press())[4], 're-tap while popup open')
    searched_at(lambda: (tap(.5, .62), time.sleep(.7), tap(.35, .55), time.sleep(.08), press())[4], 're-tap + press during fade')
    def closex():
        tap(.5, .62); time.sleep(.5)
        b = pg.locator('.leaflet-popup-close-button').last.bounding_box(); hit(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
        time.sleep(.05); tap(.4, .66); time.sleep(.4); return press()
    searched_at(closex, 'close (x) then quick re-tap')
    searched_at(lambda: (tap(.55, .6), time.sleep(.5), press(2))[2], 'double press')
    pg.evaluate('WellsApp.map.closePopup()')
    n0 = pg.evaluate('WellsApp.state.reqId')
    # Lines on, zoom 17: APN line is appended to the same popup, button must still work
    pg.evaluate("WellsParcels.set(true, 60); WellsApp.map.setView([33.0417,-116.8681], 17, {animate:false})"); time.sleep(1.5)
    def lines():
        tap(.45, .66); pg.wait_for_function("() => document.querySelector('.leaflet-popup .pc-apn')", timeout=30000); return press()
    searched_at(lines, 'Lines on, zoom 17, after APN added')
    searched_at(lambda: (tap(.45, .66), time.sleep(.2), tap(.4, .6), time.sleep(.3), press())[4], 'Lines on, re-tap before APN')
    pg.evaluate('WellsParcels.set(false)')
    # setbacks
    site = "({id:'site-test', lat:33.0417, lon:-116.8681, customer:'Test', marks:[]})"
    pg.evaluate(f'WellsSeptic.openSetbacks({site})'); time.sleep(.8)
    tap(.3, .3); time.sleep(.4)
    check(pg.locator('.leaflet-popup .search-here').count() == 0, 'setbacks open: tap marks, no Search here popup', dev)
    pg.click('#sbDone'); time.sleep(.4)
    searched_at(lambda: (tap(.3, .7), time.sleep(.5), press())[2], 'after setbacks Done')
    pg.evaluate(f'WellsSeptic.openSetbacks({site})'); time.sleep(.8)
    pg.click('#btnTagTop'); time.sleep(.4); pg.click('#gpsCancel'); time.sleep(1.2); pg.locator('#map').scroll_into_view_if_needed(); time.sleep(.5)
    searched_at(lambda: (tap(.75, .3), time.sleep(.5), press())[2], 'after setbacks closed by another sheet')
    pg.evaluate(f'WellsSeptic.openSetbacks({site})'); time.sleep(.8)
    pg.evaluate("document.getElementById('sheet').classList.add('hidden')")   # sheet gone without Done (stale flag)
    searched_at(lambda: (tap(.6, .45), time.sleep(.5), press())[2], 'stale map-tool flag self-heals')
    pg.evaluate("document.getElementById('sheet').classList.remove('hidden'); document.getElementById('sbDone') && document.getElementById('sbDone').click()")
    # offline -> clear no-signal message with Retry
    pg.evaluate("WellsApp.map.setView([33.0417,-116.8681], 15, {animate:false})"); time.sleep(.5)
    ctx.set_offline(True)
    tap(.5, .62); time.sleep(.5); press()
    pg.wait_for_function("() => !WellsApp.state.searching", timeout=60000)
    st = pg.inner_text('#status')
    check('No signal' in st and pg.locator('#btnRetry').count() == 1, f'offline: "{st[:80]}"', dev)
    ctx.set_offline(False); time.sleep(.5)
    pg.click('#btnRetry'); pg.wait_for_function("() => !WellsApp.state.searching", timeout=90000)
    check('State:' in pg.inner_text('#status'), 'Retry after signal returns works', dev)
    # county server errors -> error + Retry, search still finishes
    pg.route('**/DPLU_Map/MapServer/100/**', lambda r: r.fulfill(status=500, body='err'))
    tap(.5, .62); time.sleep(.5); press()
    pg.wait_for_function("() => !WellsApp.state.searching", timeout=90000)
    st = pg.inner_text('#status')
    check('County data failed' in st and pg.locator('#btnRetry').count() == 1, f'county 500: "{st[:90]}"', dev)
    pg.unroute('**/DPLU_Map/MapServer/100/**')
    # Del Mar Mesa (City of San Diego): no county WCR tiles, no county permits, parcel/septic lookups inside the city
    pg.evaluate("WellsApp.setLocation(32.9400, -117.1800, 'test')"); pg.wait_for_function("() => !WellsApp.state.searching", timeout=90000)
    pg.evaluate("WellsApp.map.setView([32.9400, -117.1800], 16, {animate:false})"); time.sleep(.8)
    for i, (fx, fy) in enumerate([(.3, .7), (.65, .45)]):
        searched_at(lambda: (tap(fx, fy), time.sleep(.5), press())[2], f'Del Mar Mesa (no county data) search {i + 1}')
        nt = pg.inner_text('.map-note')
        check(bool(re.search(r'wells? (found )?within|nearest', nt)), f'Del Mar Mesa: result shown on the map ("{nt[:70]}")', dev)
    check(not errs, 'no page errors ' + '; '.join(errs[:5]), dev)
    br.close()

with sync_playwright() as pw:
    for dev in ['desktop', 'phone']:
        if not a.only or a.only == dev: run(pw, dev)
print('FAIL: ' + ' | '.join(fail) if fail else 'PASS')
sys.exit(1 if fail else 0)
