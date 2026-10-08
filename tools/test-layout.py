#!/usr/bin/env python3
"""Headless phone test of ✏️ Septic layout (js/layout.js + js/layout-core.js): open drawing mode, parcel lines from APN, draw a
well / tank / pit / leach line / house / leach field / text / measurement with real taps, colours + legend, setback rings + warnings,
edit, undo, save + reload from IndexedDB, plot plan PNG + PDF exports, layouts list, JSON backup, nothing uploaded, 0 page errors,
existing features unchanged (well pins + APN search). The demo layout is SYNTHETIC (fake owner name), drawn on APN 285-030-06-00.
Usage: /workspace/.venv-pw/bin/python tools/test-layout.py [--base URL] [--shots DIR]   (screenshots are not part of the repo)"""
import sys, os, http.server, threading, functools, argparse, tempfile, json, re, struct
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default=''); a = ap.parse_args()
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
APN = '285-030-06-00'
OWNER = 'Quentin Layouttester'      # fake
def shot(pg, name):
    if a.shots: pth = os.path.join(a.shots, name); pg.screenshot(path=pth); print('screenshot:', pth)

with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
    ctx = p.chromium.launch_persistent_context(os.path.join(tmp, 'prof'), executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
        viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2, accept_downloads=True)
    pg = ctx.new_page(); errs, reqs = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
    pg.on('request', lambda r: reqs.append((r.method, r.url, r.post_data or '')))
    pg.on('dialog', lambda d: d.accept())
    # ---- existing behaviour: well pins near Ramona, APN search
    pg.goto(f'{base}index.html?lat=33.04&lon=-116.87&r=0.5')
    pg.wait_for_selector('#summary:not(.hidden)', timeout=90000)
    n0 = pg.evaluate('() => WellsApp.state.shown.length'); npins = pg.locator('#map .leaflet-marker-icon, #map path.leaflet-interactive').count()
    check(n0 > 0 and npins > 0, f'well search near 33.04,-116.87 still works ({n0} wells, {npins} pins)')
    check(pg.evaluate('() => !!(window.WellsLayout && window.LayoutCore)'), 'layout modules loaded')
    check(pg.locator('#btnLayout').is_visible(), '✏️ Septic layout button in the bottom bar')
    pg.evaluate("() => { WellsApp.state.lat = 0; WellsApp.state.lon = 0; }")
    inp = pg.locator('.as-input'); inp.fill(APN); inp.press('Enter')
    try: pg.wait_for_function('() => WellsApp.state.lat !== 0', timeout=40000)
    except Exception: pass
    st = pg.evaluate('({lat: WellsApp.state.lat, lon: WellsApp.state.lon, how: WellsApp.state.how})')
    check(st['lat'] != 0 and f'APN {APN}' in (st['how'] or '').upper(), f'APN search {APN} still works -> {st}')
    pg.wait_for_selector('#summary:not(.hidden)', timeout=60000); pg.wait_for_timeout(500)
    # ---- new layout: prefilled from the search, parcel lines from the County
    pg.click('#btnLayout'); pg.wait_for_selector('#lnName')
    try: pg.wait_for_function(f"() => document.getElementById('lnApn').value === '{APN}'", timeout=15000)
    except Exception: pass
    check(pg.input_value('#lnApn') == APN, f'new layout: APN prefilled from the search ({pg.input_value("#lnApn")!r})')
    pg.click('#lnGo'); check('owner' in pg.inner_text('#lnErr').lower(), 'name required')
    pg.fill('#lnName', OWNER); pg.click('#lnGo')
    pg.wait_for_selector('#loTabs'); 
    check(pg.evaluate("() => document.body.classList.contains('layout-open') && WellsLayout.isActive() && WellsApp.state.mapTool"), 'drawing mode open (map full screen, taps belong to the tool)')
    try: pg.wait_for_function("() => WellsLayout.current && WellsLayout.current.shapes.some(s => s.src === 'parcel')", timeout=40000); okp = True
    except Exception: okp = False
    par = pg.evaluate("() => { const l = WellsLayout.current; const s = l.shapes.filter(s => s.src === 'parcel'); return {n: s.length, pts: s.reduce((a, x) => a + x.pts.length, 0), ft: s.map(x => LayoutCore.lengthFt(x.pts.concat([x.pts[0]]))), apn: l.apn, tab: document.querySelector('#loTabs .on') && document.querySelector('#loTabs .on').dataset.t}; }")
    check(okp and par['n'] >= 1 and par['pts'] >= 4 and 1000 < sum(par['ft']) < 5000, f'parcel lines loaded from APN {par}')
    m = pg.evaluate('() => { const b = document.getElementById("map").getBoundingClientRect(); return [b.top, b.height, window.innerHeight]; }')
    check(m[0] <= 1 and m[1] > 844 * 0.5, f'map fills the top of the screen in drawing mode ({m})')
    # ---- helpers: tap the map at feet east/north of the parcel centre
    C = pg.evaluate("() => LayoutCore.centroid(WellsLayout.current.shapes.find(s => s.src === 'parcel').pts)")
    pg.evaluate(f'() => WellsApp.map.setView([{C[0]}, {C[1]}], 19, {{animate: false}})'); pg.wait_for_timeout(500)
    def xy(e, n):
        ll = pg.evaluate(f'() => SepticCore.projector({C[0]}, {C[1]}).inv({e}/3.28084, {n}/3.28084)')
        c = pg.evaluate(f'() => WellsApp.map.latLngToContainerPoint([{ll[0]}, {ll[1]}])'); b = pg.locator('#map').bounding_box()
        return b['x'] + c['x'], b['y'] + c['y']
    def tap(e, n, wait=300):
        x, y = xy(e, n); pg.touchscreen.tap(x, y); pg.wait_for_timeout(wait)
    def tool(k): pg.click(f'.lo-tool[data-k={k}]'); pg.wait_for_timeout(150)
    def nshapes(): return pg.evaluate('() => WellsLayout.current.shapes.length')
    def sel_done():
        if pg.locator('#loSelDone').count(): pg.click('#loSelDone'); pg.wait_for_timeout(150)
    # zoom 19 on a 390px-wide map is ~ 0.98 ft/px at this latitude: keep everything within ~ +-150 ft
    tool('well'); check('Tap the map' in pg.inner_text('#loBody'), 'tool instructions shown'); tap(0, 0)
    check(nshapes() == par['n'] + 1 and pg.locator('.lo-pt').count() == 1, 'well point added by a tap')
    rings = pg.evaluate("() => { const r = []; WellsApp.map.eachLayer(l => { if (l instanceof L.Circle) r.push(Math.round(l.getRadius() * 3.28084)); }); return r.sort((a, b) => a - b); }")
    check(all(x in rings for x in (50, 100, 150)), f'setback rings 50 / 100 / 150 ft around the well ({rings})')
    sel_done()
    tool('tank'); tap(60, -20)
    s = pg.inner_text('#loSum'); check('setback problem' in s, f'tank 63 ft from the well flagged: {s[:90]!r}')
    check(pg.locator('.lo-pt.bad').count() == 1, 'violating tank highlighted red on the map')
    sel_done()
    # leach line: 3 taps then tap the last point again to finish
    tool('leach'); tap(-40, -110); tap(0, -125); tap(40, -110)
    check('3 points' in pg.inner_text('#loBody'), 'leach line: live point count + length while drawing')
    tap(40, -110)
    lf = pg.evaluate("() => { const s = WellsLayout.current.shapes.find(s => s.kind === 'leach'); return s && LayoutCore.lengthFt(s.pts); }")
    check(lf and 75 < lf < 95, f'leach line finished by tapping the last point again ({lf and round(lf)} ft)')
    check(pg.locator('#loSelDone').count() == 1 and 'ft' in pg.inner_text('.lo-selhead'), 'new line selected with its length')
    # change its colour to orange + dashed -> new legend entry
    pg.click('#loSelPal button[data-c="#f97316"]'); pg.wait_for_timeout(150); pg.click('#loSelDash button[data-d=dashed]'); pg.wait_for_timeout(150)
    pg.fill('#loLegName', 'Leach line (3 ft trench)'); pg.wait_for_timeout(200)
    st = pg.evaluate("() => { const l = WellsLayout.current, s = l.shapes.find(s => s.kind === 'leach'); return LayoutCore.styleOf(l, s); }")
    check(st['color'] == '#f97316' and st['dash'] == 'dashed' and st['label'] == 'Leach line (3 ft trench)', f'colour + dash + legend name applied {st}')
    leg = pg.inner_text('.lo-mapleg')
    check('Leach line (3 ft trench)' in leg and '100 ft well setback' in leg, 'on-map legend shows the entry + rings')
    sel_done()
    # house: rectangle by 3 taps
    tool('house'); tap(-60, 40); tap(-20, 40); tap(-20, 80)
    h = pg.evaluate("() => { const s = WellsLayout.current.shapes.find(s => s.kind === 'house'); return s && [s.pts.length, LayoutCore.areaSqFt(s.pts)]; }")
    check(h and h[0] == 4 and 1400 < h[1] < 1800, f'house rectangle from 3 taps ({h})')
    sel_done()
    # leach field: any shape, 4 corners then tap the first one
    tool('field'); pg.click('#loPolyMode button[data-m=poly]'); tap(-50, -140); tap(50, -140); tap(50, -104); tap(-50, -104); tap(-50, -140)
    f = pg.evaluate("() => { const s = WellsLayout.current.shapes.find(s => s.kind === 'field'); return s && [s.pts.length, LayoutCore.areaSqFt(s.pts)]; }")
    check(f and f[0] == 4 and 3200 < f[1] < 4000, f'leach field polygon closed by tapping the first corner ({f})')
    sel_done()
    tool('pit'); tap(120, 110); sel_done()
    tool('text'); tap(-40, 95); pg.wait_for_timeout(200); pg.fill('#loText', 'Proposed house'); sel_done()
    tool('dim'); tap(0, 0); tap(-20, 60)
    dm = pg.evaluate("() => { const s = WellsLayout.current.shapes.find(s => s.kind === 'dim'); return s && LayoutCore.lengthFt(s.pts); }")
    check(dm and 60 < dm < 66, f'measure: two taps -> {dm and round(dm)} ft')
    sel_done()
    rows = pg.evaluate("() => LayoutCore.setbackChecks(WellsLayout.current).rows.map(r => [r.shape.kind, r.status, r.ftRounded])")
    print('setbacks:', rows)
    d = {k: (s_, ft) for k, s_, ft in rows}
    check(d['tank'][0] == 'inside' and d['leach'][0] == 'ok' and d['pit'][0] == 'ok' and d['field'][0] == 'near', f'tank inside 100 ft, leach line + pit ok, leach field just outside (near) {d}')
    # edit: drag the tank 60 ft further east -> clears the 100 ft setback
    pg.locator('.lo-pt').nth(1).bounding_box()
    tk = pg.evaluate("() => WellsLayout.current.shapes.find(s => s.kind === 'tank').id"); pg.evaluate(f"() => WellsLayout.select('{tk}')"); pg.wait_for_timeout(200)
    hb = pg.locator('.lo-h').first.bounding_box(); x0, y0 = hb['x'] + hb['width'] / 2, hb['y'] + hb['height'] / 2
    x1, _ = xy(115, -20)
    pg.mouse.move(x0, y0); pg.mouse.down(); pg.mouse.move((x0 + x1) / 2, y0, steps=5); pg.mouse.move(x1, y0, steps=5); pg.mouse.up(); pg.wait_for_timeout(400)
    tr = pg.evaluate("() => LayoutCore.setbackChecks(WellsLayout.current).rows.find(r => r.shape.kind === 'tank')")
    check(tr['status'] == 'ok' and tr['ftRounded'] >= 100, f'dragged the tank: now {tr["ftRounded"]} ft ({tr["status"]})')
    pg.click('#loUndo'); pg.wait_for_timeout(300)
    tr = pg.evaluate("() => LayoutCore.setbackChecks(WellsLayout.current).rows.find(r => r.shape.kind === 'tank')")
    check(tr['status'] == 'inside', f'↶ Undo puts it back ({tr["ftRounded"]} ft, {tr["status"]})')
    sel_done()
    pg.wait_for_timeout(2500)
    shot(pg, 'layout-drawing-legend.png')
    pg.evaluate('() => WellsApp.map.setZoom(18, {animate: false})'); pg.wait_for_timeout(2500)
    shot(pg, 'layout-setback-rings.png')
    # items tab
    pg.click('#loTabs button[data-t=items]'); n_it = pg.locator('.lo-item').count()
    check(n_it == nshapes() and pg.locator('.lo-item.inside').count() == 1, f'Items tab lists {n_it} items, 1 setback problem')
    pg.click('#loTabs button[data-t=legend]'); check(pg.locator('.lo-leg').count() >= 10, f'Legend tab: {pg.locator(".lo-leg").count()} editable entries')
    # ---- save + reload from IndexedDB
    n_before = nshapes(); lid = pg.evaluate('() => WellsLayout.current.id')
    pg.click('#loDone'); pg.wait_for_timeout(600)
    check(pg.evaluate("() => !WellsLayout.isActive() && !WellsApp.state.mapTool && !document.body.classList.contains('layout-open')"), 'Done leaves drawing mode')
    pg.reload(); pg.wait_for_function('window.WellsLayout && window.WellsApp', timeout=60000); pg.wait_for_timeout(1500)
    pg.click('#btnLayout'); pg.wait_for_selector('.l-item')
    check(OWNER in pg.inner_text('.l-item') and 'setback problem' in pg.inner_text('.l-item'), 'layouts list after reload: name + setback warning')
    pg.click('.l-item .ll-open'); pg.wait_for_selector('#loTabs')
    got = pg.evaluate('() => [WellsLayout.current.id, WellsLayout.current.shapes.length, LayoutCore.styleOf(WellsLayout.current, WellsLayout.current.shapes.find(s => s.kind === "leach")).label]')
    check(got[0] == lid and got[1] == n_before and got[2] == 'Leach line (3 ft trench)', f'layout reloaded from IndexedDB {got}')
    # ---- plot plan exports
    pg.click('#loTabs button[data-t=plan]'); pg.fill('#loNotes', 'Synthetic test layout. 1,000 gal tank, 80 ft leach line.')
    out = {}
    for fmt in ('png', 'pdf'):
        with pg.expect_download(timeout=120000) as dl: pg.click('#loPng' if fmt == 'png' else '#loPdf')
        pth = os.path.join(a.shots or tmp, f'layout-plot-plan.{fmt}'); dl.value.save_as(pth); out[fmt] = pth
        print(fmt, dl.value.suggested_filename, os.path.getsize(pth), pg.evaluate('() => WellsLayout.lastExport'))
    png = open(out['png'], 'rb').read(); w, hh = struct.unpack('>II', png[16:24])
    ex = pg.evaluate('() => WellsLayout.lastExport')
    check(png[:8] == b'\x89PNG\r\n\x1a\n' and len(png) > 300000 and (w, hh) == (2200, 1700), f'PNG plot plan {w}x{hh}, {len(png)//1024} KB')
    pdf = open(out['pdf'], 'rb').read()
    check(pdf[:5] == b'%PDF-' and b'/DCTDecode' in pdf and b'%%EOF' in pdf[-10:] and len(pdf) > 200000, f'PDF plot plan {len(pdf)//1024} KB')
    check(ex['tilesOk'] >= ex['tiles'] * 0.9 and ex['tiles'] > 0, f'satellite tiles in the export: {ex["tilesOk"]}/{ex["tiles"]} (z{ex["tileZoom"]}, 1 in = {ex["ftPerInch"]} ft)')
    check('✓' in pg.inner_text('#loExpMsg') or 'Saved' in pg.inner_text('#loExpMsg'), 'export message: ' + pg.inner_text('#loExpMsg')[:100])
    with pg.expect_download() as dl: pg.click('#loJson')
    bk = json.loads(open(dl.value.path()).read())
    check(bk.get('kind') == 'septic-layout' and len(bk['layout']['shapes']) == n_before, 'JSON backup has the whole layout')
    # import the backup as a copy
    pg.click('#loList'); pg.wait_for_selector('#llImport', state='attached')
    pg.set_input_files('#llImport', dl.value.path()); pg.wait_for_timeout(1200)
    check(pg.locator('.l-item').count() == 2 and '(imported)' in pg.inner_text('#llItems'), 'backup imports as a copy')
    pg.locator('.l-item .ll-del').nth(1).click(); pg.wait_for_timeout(600)
    check(pg.locator('.l-item').count() == 1, 'layout deleted (after confirm)')
    pg.click('#llClose'); pg.wait_for_timeout(300)
    # ---- map taps normal again; tagged site -> layout
    pg.locator('#map').scroll_into_view_if_needed(); pg.wait_for_timeout(400)
    b = pg.locator('#map').bounding_box(); got_sh = False
    for fx, fy in ((0.3, 0.4), (0.75, 0.3), (0.25, 0.75), (0.7, 0.7), (0.5, 0.2)):   # first spot with no well pin under the finger
        pg.evaluate('() => WellsApp.map.closePopup()'); pg.mouse.click(b['x'] + b['width'] * fx, b['y'] + b['height'] * fy); pg.wait_for_timeout(1000)
        if pg.locator('.leaflet-popup #searchHere').count(): got_sh = True; break
    check(got_sh, 'after leaving: normal tap popup ("Search here") works again')
    pg.evaluate('() => WellsApp.map.closePopup()')
    # ---- privacy
    leak = [u for (m_, u, body) in reqs if 'layouttester' in (u + body).lower() or 'quentin' in (u + body).lower() or 'synthetic test' in (u + body).lower()]
    posts = [u for (m_, u, body) in reqs if m_ not in ('GET', 'HEAD', 'OPTIONS') and 'sandiegocounty' not in u and 'sangis' not in u]
    check(not leak, f'no layout data in any of {len(reqs)} requests {leak[:2]}')
    check(not posts, f'no uploads {posts[:2]}')
    if a.shots:
        pg2 = ctx.new_page(); pg2.set_viewport_size({'width': 390, 'height': 844})
        pg2.goto('file://' + out['png']); pg2.wait_for_timeout(500); pg2.screenshot(path=os.path.join(a.shots, 'layout-plot-plan-on-phone.png')); pg2.close()
    check(not errs, 'no page errors' + (f': {errs[:3]}' if errs else ''))
    ctx.close()
if srv: srv.shutdown()
print('ALL PASS' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
