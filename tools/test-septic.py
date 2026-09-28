#!/usr/bin/env python3
"""Headless phone test of the septic / sewer features (js/septic.js): records + status for a tagged site and a tapped parcel,
neighbors, setback rings + tap-to-mark with warnings, edit/delete, persistence, exports, sewer reference layers, privacy.
Usage: /workspace/.venv-pw/bin/python tools/test-septic.py [--base URL] [--shots /workspace]"""
import sys, os, http.server, threading, functools, argparse, tempfile, json, re
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default='/workspace'); a = ap.parse_args()
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
LAT, LON = 33.0375787, -116.8452545          # 309 Calle Amistad, Ramona (APN 284-291-60-00, known septic)
NAME, PHONE = 'Zebulon Septictester', '760-555-0199'
with sync_playwright() as p, tempfile.TemporaryDirectory() as prof:
    ctx = p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', args=['--no-sandbox'], viewport={'width': 390, 'height': 844},
        is_mobile=True, has_touch=True, device_scale_factor=2, accept_downloads=True, geolocation={'latitude': LAT, 'longitude': LON, 'accuracy': 3}, permissions=['geolocation'])
    pg = ctx.new_page(); errs, reqs = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
    pg.on('request', lambda r: reqs.append(r.url))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(f'{base}index.html?lat={LAT}&lon={LON}&r=0.25')
    pg.wait_for_selector('#summary:not(.hidden)', timeout=90000)
    check(pg.evaluate('() => !!(window.WellsSeptic && window.SepticCore)'), 'septic modules loaded')
    # ---- tag a site (APN + situs stored at tagging time)
    pg.click('#btnTag'); pg.wait_for_timeout(2500); pg.click('#gpsCapture')
    pg.wait_for_function("() => /APN \\d{3}-\\d{3}-\\d{2}-\\d{2}/.test(document.getElementById('fParcel').innerText)", timeout=30000)
    pg.fill('#fName', NAME); pg.fill('#fPhone', PHONE); pg.click('#fSave'); pg.wait_for_timeout(800)
    s = pg.evaluate('() => { const s = WellsSites.sites[0]; return {apn: s.apn, num: s.parcel.situsNum, street: s.parcel.situsStreet}; }')
    check(s['apn'] == '284-291-60-00' and str(s['num']) == '309' and s['street'] == 'CALLE AMISTAD', f'APN + street stored at tagging time {s}')
    # ---- (a)+(b) site popup: status + records
    pg.evaluate('() => WellsSites.showOnMap(WellsSites.sites[0])')
    try: pg.wait_for_selector('.leaflet-popup .sep-status', state='attached', timeout=40000); pg.wait_for_selector('.leaflet-popup .sep-recs', state='attached', timeout=60000)
    except Exception as e: print('POPUP:', pg.inner_text('.leaflet-popup') if pg.locator('.leaflet-popup').count() else 'none', errs); raise
    st = pg.inner_text('.leaflet-popup .sep-status')
    check('Septic (confirmed)' in st and 'level 2 of 6' in st and 'May 2025' in st, f'status in plain words + level + screening caveat ({st[:90]!r}…)')
    check('Neighbors within ~200 ft' in st and 'septic' in st.split('Neighbors')[1], 'neighbor counts shown')
    recs = pg.evaluate("""() => [...document.querySelectorAll('.leaflet-popup .sep-recs li a')].map(a => ({t: a.innerText, h: a.href, target: a.target}))""")
    rtext = pg.inner_text('.leaflet-popup .sep-recs')
    print('records:', [r['t'] for r in recs]); print('  ', rtext.splitlines()[-1])
    check(sum('layout' in r['t'] for r in recs) >= 2 and any('archive' in r['t'] for r in recs), f'site records: {len(recs)} (2+ layouts + archive file)')
    check(all('LUEG_View?FileRecordId=' in r['h'] and r['target'] == '_blank' for r in recs), 'links open the County LUEG_View viewer')
    check(len({r['h'] for r in recs}) == len(recs), 'records de-duplicated by FileRecordId')
    check('APN 284-291-60' in rtext and '309 CALLE AMISTAD' in rtext, 'searched by APN first, then by address')
    pg.locator('#map').scroll_into_view_if_needed(); pg.wait_for_timeout(800)
    pg.evaluate("() => { const c = document.querySelector('.leaflet-popup-content'); const b = c.querySelector('.sep-box'); c.scrollTop = b.offsetTop - 60; }")
    fits = pg.evaluate("() => { const m = document.getElementById('map').getBoundingClientRect(), p = document.querySelector('.leaflet-popup-content-wrapper').getBoundingClientRect(); return p.top >= m.top - 1 && p.bottom <= m.bottom + 1; }")
    check(fits, 'site popup fits inside the map (scrolls instead of being cut off)')
    pg.wait_for_timeout(1500)
    shot1 = os.path.join(a.shots, 'septic-site-popup.png'); pg.screenshot(path=shot1); print('screenshot:', shot1)
    pg.click('.leaflet-popup .sep-nbbtn'); pg.wait_for_selector('.leaflet-popup .sep-nbres div, .leaflet-popup .sep-nbp', timeout=60000)
    nb = pg.inner_text('.leaflet-popup .sep-nbres')
    check(bool(re.search(r'\d+ other parcels? on page 284-291', nb)) and '284-291-60' not in nb.split('\n', 1)[-1], f'neighbors on assessor page ({nb.splitlines()[0]!r})')
    pg.wait_for_timeout(500)
    cache = pg.evaluate('async () => { const s = (await WellsSites.Store.all())[0]; return s.septic ? {st: s.septic.status && s.septic.status.own.short, n: s.septic.records && s.septic.records.docs.length} : null; }')
    check(cache and cache['st'] == 'Septic (confirmed)' and cache['n'] == len(recs), f'offline copy saved with the site {cache}')
    pg.evaluate('() => WellsApp.map.closePopup()')
    # ---- tapped parcel (1082 Heritage Ranch Rd, 279-220-12-00)
    pg.evaluate('() => WellsApp.map.setView([33.0665071, -116.8760355], 18, {animate: false})'); pg.wait_for_timeout(800)
    box = pg.locator('#map').bounding_box(); c = pg.evaluate('() => WellsApp.map.latLngToContainerPoint([33.0665071, -116.8760355])')
    pg.mouse.click(box['x'] + c['x'], box['y'] + c['y'])
    pg.wait_for_selector('.leaflet-popup .sep-tapbtn', timeout=10000); pg.click('.leaflet-popup .sep-tapbtn')
    pg.wait_for_selector('.leaflet-popup .sep-status', timeout=40000); pg.wait_for_selector('.leaflet-popup .sep-recs', timeout=60000)
    t = pg.inner_text('.leaflet-popup-content')
    n2 = pg.locator('.leaflet-popup .sep-recs li').count()
    check('279-220-12-00' in t and 'Septic (confirmed)' in t and n2 >= 3 and pg.locator('.leaflet-popup #searchHere').count() == 1, f'tapped parcel: APN, status, {n2} records, "Search here" kept')
    pg.evaluate('() => WellsApp.map.closePopup()')
    # ---- (c) setbacks
    pg.evaluate('() => WellsSites.showOnMap(WellsSites.sites[0])'); pg.wait_for_selector('.leaflet-popup .act-setbacks', timeout=10000)
    pg.click('.leaflet-popup .act-setbacks'); pg.wait_for_selector('#sbTools'); pg.wait_for_timeout(800)
    radii = pg.evaluate("() => { const r = []; WellsApp.map.eachLayer(l => { if (l instanceof L.Circle && !(l instanceof L.CircleMarker && !(l instanceof L.Circle))) r.push(+(l.getRadius()*3.28084).toFixed(2)); }); return r.sort((a,b)=>a-b); }")
    check([50.0, 100.0, 150.0] == [x for x in radii if x in (50.0, 100.0, 150.0)], f'rings at 50 / 100 / 150 ft ({radii})')
    check(pg.evaluate('() => WellsApp.state.mapTool === true'), 'map taps belong to the marking tool')
    def tap_ft(e, n):
        ll = pg.evaluate(f'() => SepticCore.projector({LAT}, {LON}).inv({e}/3.28084, {n}/3.28084)')
        c = pg.evaluate(f'() => WellsApp.map.latLngToContainerPoint([{ll[0]}, {ll[1]}])'); b = pg.locator('#map').bounding_box()
        pg.mouse.click(b['x'] + c['x'], b['y'] + c['y']); pg.wait_for_timeout(350)
    # empty tap: no Search-here popup
    tap_ft(0, 40); check(pg.locator('.leaflet-popup #searchHere').count() == 0, 'tap with no tool: no "Search here" popup')
    pg.click('#sbTools button[data-kind=leach]')
    check('Tap each point' in pg.inner_text('#sbInstr') and pg.is_disabled('#sbFinish'), 'leach tool: instructions, Finish disabled until 2 points')
    tap_ft(-70, 72); tap_ft(70, 72)
    check('2 points' in pg.inner_text('#sbInstr') and not pg.is_disabled('#sbFinish'), 'two taps -> 2 points, Finish enabled')
    pg.click('#sbFinish'); pg.wait_for_timeout(500)
    item = pg.inner_text('.sb-item.inside') if pg.locator('.sb-item.inside').count() else ''
    ft = int(re.search(r'is (\d+) ft', item).group(1)) if item else -1
    check(71 <= ft <= 73 and 'inside the 100 ft setback' in item, f'leach line warning: {item!r}')
    check('setback problem' in pg.inner_text('#sbSummary'), 'red summary banner: ' + pg.inner_text('#sbSummary'))
    pg.locator('#map').scroll_into_view_if_needed(); pg.wait_for_timeout(3000)
    shot2 = os.path.join(a.shots, 'septic-setback-warning.png'); pg.screenshot(path=shot2); print('screenshot:', shot2)
    pg.click('#sbTools button[data-kind=tank]'); tap_ft(130, -20)
    pg.click('#sbTools button[data-kind=pit]'); tap_ft(-40, -110)
    rows = pg.evaluate("() => [...document.querySelectorAll('.sb-item')].map(x => [x.className.split(' ')[1], x.innerText.split('\\n')[0]])")
    print('marks:', rows)
    check(len(rows) == 3 and rows[1][0] == 'ok' and rows[2][0] == 'inside' and 'Seepage pit' in rows[2][1] and '150 ft' in rows[2][1], 'tank at ~132 ft ok; pit at ~117 ft inside 150 ft')
    # edit: move the leach line 40 ft north by dragging both handles
    pg.locator('.sb-item').nth(0).locator('button[data-act=edit]').click(); pg.wait_for_timeout(400)
    hs = pg.locator('.mark-handle'); check(hs.count() == 2, 'edit shows 2 drag handles')
    dy = pg.evaluate(f'() => {{ const m = WellsApp.map; const a = m.latLngToContainerPoint([{LAT}, {LON}]); const ll = SepticCore.projector({LAT}, {LON}).inv(0, 40/3.28084); return a.y - m.latLngToContainerPoint(ll).y; }}')
    for i in range(2):
        bb = hs.nth(i).bounding_box(); x0, y0 = bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2
        pg.mouse.move(x0, y0); pg.mouse.down(); pg.mouse.move(x0, y0 - dy / 2, steps=4); pg.mouse.move(x0, y0 - dy, steps=4); pg.mouse.up(); pg.wait_for_timeout(300)
    pg.locator('.sb-item').nth(0).locator('button[data-act=save]').click(); pg.wait_for_timeout(400)
    t0 = pg.locator('.sb-item').nth(0).inner_text()
    ft2 = int(re.search(r'is (\d+) ft', t0).group(1))
    check(108 <= ft2 <= 116 and '✓' in t0, f'moved leach line: {t0.splitlines()[0]!r}')
    pg.locator('.sb-item').nth(2).locator('button[data-act=del]').click(); pg.wait_for_timeout(400)
    check(pg.locator('.sb-item').count() == 2 and pg.locator('.sb-item.inside').count() == 0, 'pit deleted (confirm) -> no warnings')
    mains = pg.inner_text('#sbMains'); check('sewer main' in mains, 'public sewer main check: ' + mains[:80])
    pg.click('#sbDone'); pg.wait_for_timeout(400)
    check(pg.evaluate('() => !WellsApp.state.mapTool') and pg.locator('#sheet.hidden').count() == 1, 'Done closes the tool')
    tap_ft(0, 40); check(pg.locator('.leaflet-popup #searchHere').count() == 1, 'normal tap popup works again')
    # add the warning back for exports, then reload
    pg.evaluate('() => WellsApp.map.closePopup()')
    pg.evaluate('() => WellsSeptic.openSetbacks(WellsSites.sites[0])'); pg.wait_for_timeout(600)
    pg.click('#sbTools button[data-kind=sewer]'); tap_ft(30, -60); tap_ft(30, 60); pg.click('#sbFinish'); pg.click('#sbDone')
    pg.reload(); pg.wait_for_selector('#summary:not(.hidden)', timeout=90000); pg.wait_for_timeout(800)
    mk = pg.evaluate('() => WellsSites.sites[0].marks.map(m => [m.kind, m.pts.length])')
    check(mk == [['leach', 2], ['tank', 1], ['sewer', 2]], f'marks saved on the device after reload {mk}')
    # offline: the site popup shows the saved copy of status + records
    ctx.set_offline(True)
    pg.evaluate('() => WellsSites.showOnMap(WellsSites.sites[0])')
    try: pg.wait_for_function("() => { const t = (document.querySelector('.leaflet-popup .sep-box') || {}).innerText || ''; return (t.match(/offline copy/g) || []).length >= 2; }", timeout=60000); off = True
    except Exception: off = False
    check(off and pg.locator('.leaflet-popup .sep-recs li').count() >= 3, 'offline: saved status + records shown in the site popup')
    ctx.set_offline(False); pg.evaluate('() => WellsApp.map.closePopup()')
    # exports
    pg.click('#btnSites'); pg.wait_for_selector('.l-item')
    check('setback problem' in pg.inner_text('.l-item'), 'site list shows the setback warning')
    dl = {}
    for bid in ['lCsv', 'lKml', 'lJson']:
        with pg.expect_download() as d: pg.click('#' + bid)
        path = os.path.join(tempfile.gettempdir(), d.value.suggested_filename); d.value.save_as(path); dl[bid] = open(path).read()
    csv = dl['lCsv']
    check('Setback warnings' in csv and 'Sewer line' in csv and 'INSIDE' in csv and 'Septic (confirmed)' in csv, 'CSV has status, warnings and marks')
    check(dl['lKml'].count('<LineString>') >= 5 and '100 ft setback' in dl['lKml'] and 'INSIDE' in dl['lKml'], 'KML has rings + marks')
    bk = json.loads(dl['lJson'])['sites'][0]
    check(len(bk.get('marks', [])) == 3, 'backup JSON includes the marks')
    pg.click('#lClose')
    # reference layers
    pg.evaluate('() => WellsApp.map.setView([33.04, -116.87], 13, {animate: false})')
    pg.click('.sewer-ctl .sw-btn'); pg.check('.sewer-ctl .sw-areas')
    pg.wait_for_function("() => document.querySelectorAll('.leaflet-overlay-pane path[stroke=\"#14b8a6\"], .leaflet-overlay-pane path[stroke=\"#38bdf8\"]').length >= 2", timeout=90000)
    check(True, 'sewer service areas drawn (LAFCO + County SD)')
    pg.evaluate('() => WellsApp.map.setView([32.8595, -116.9195], 16, {animate: false})'); pg.check('.sewer-ctl .sw-mains')
    pg.wait_for_function("() => document.querySelectorAll('path.sewer-main').length > 0", timeout=60000)
    nm = pg.locator('path.sewer-main').count(); check(nm > 0, f'County SD sewer mains drawn in Lakeside ({nm})')
    pg.locator('#map').screenshot(path='/tmp/septic-mains.png')
    near = pg.evaluate('() => WellsSeptic.mainsNear({lat: 32.86016, lon: -116.91983})')
    check(near['best'] and near['best']['ft'] < 5, f'mainsNear finds a pipe next to a point on it ({near["best"]})')
    pg.uncheck('.sewer-ctl .sw-mains'); pg.uncheck('.sewer-ctl .sw-areas')
    # privacy
    leak = [u for u in reqs if 'Zebulon' in u or 'Septictester' in u or '555-0199' in u]
    check(not leak, f'no customer data in any request ({len(reqs)} requests)')
    check(not errs, 'no page errors' + (f': {errs[:3]}' if errs else ''))
    ctx.close()
if srv: srv.shutdown()
print('ALL PASS' if not fails else f'{len(fails)} FAILED'); sys.exit(1 if fails else 0)
