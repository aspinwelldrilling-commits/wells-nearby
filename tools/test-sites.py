"""Headless phone test of the proposed-well-site feature (mock GPS, parcel lookup, save, list, export, import, offline).
Usage: /workspace/.venv-pw/bin/python tools/test-sites.py [lat lon name] [--base URL] [--out prefix]"""
import sys, os, http.server, threading, functools, json
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = {sys.argv[i][2:]: sys.argv[i + 1] for i in range(1, len(sys.argv) - 1) if sys.argv[i].startswith('--')}
lat, lon = (float(args[0]), float(args[1])) if len(args) >= 2 else (33.0417, -116.8681)
name = args[2] if len(args) >= 3 else 'Test Customer'
out = opt.get('out', os.path.join(root, '.cache', 'site'))
base = opt.get('base')
if not base:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_address[1]}/'
photo = os.path.join(root, '.cache', 'test-photo.jpg')
ok = lambda c, m: print(('PASS ' if c else 'FAIL ') + m)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True,
                        geolocation={'latitude': lat + 0.0003, 'longitude': lon + 0.0003, 'accuracy': 45}, permissions=['geolocation'])
    pg = ctx.new_page()
    pg.on('console', lambda m: print('console:', m.type, m.text) if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: print('PAGEERROR', e))
    pg.on('dialog', lambda d: d.accept())
    reqs = []
    pg.on('request', lambda r: reqs.append(r.url))
    pg.goto(base + f'index.html?lat={lat}&lon={lon}&r=0.5')
    pg.wait_for_selector('#summary:not(.hidden)', timeout=60000)
    # 1) GPS capture: poor fix first, then a good one
    pg.click('#btnTag'); pg.wait_for_selector('#gpsAcc'); pg.wait_for_timeout(2500)
    print('gps1:', pg.inner_text('#gpsAcc').replace('\n', ' '), '|', pg.inner_text('#gpsCapture'))
    ctx.set_geolocation({'latitude': lat, 'longitude': lon, 'accuracy': 3.5}); pg.wait_for_timeout(2500)
    acc = pg.inner_text('#gpsAcc').replace('\n', ' ')
    print('gps2:', acc, '|', pg.inner_text('#gpsCapture'), '|', pg.inner_text('#gpsSub'))
    ok('11 ft' in acc or '12 ft' in acc, 'live accuracy in feet updates to best fix')
    pg.screenshot(path=out + '-1-gps.png')
    pg.click('#gpsCapture')
    # 2) parcel lookup
    pg.wait_for_function("() => /APN \\d{3}-\\d{3}-\\d{2}-\\d{2}/.test(document.getElementById('fParcel').innerText)", timeout=20000)
    parcel = pg.inner_text('#fParcel').replace('\n', ' | '); apn = pg.input_value('#fApn')
    print('parcel:', parcel, '| APN field:', apn)
    ok(len(apn) == 13, 'APN auto-filled from County GIS')
    ok(pg.evaluate("() => document.querySelectorAll('.leaflet-overlay-pane path').length") > 0, 'parcel outline drawn')
    # 3) form: save without name -> error, then name/phone/notes/photo
    pg.click('#fSave'); ok('required' in pg.inner_text('#fErr'), 'customer name required')
    pg.fill('#fName', name); pg.fill('#fPhone', '760-555-0142'); pg.fill('#fNotes', 'Gate code 1234. Power at barn.')
    pg.set_input_files('#fPhoto', photo); pg.wait_for_function("() => /KB/.test(document.getElementById('fPhotoInfo').innerText)", timeout=15000)
    print('photo:', pg.inner_text('#fPhotoInfo'))
    # drag the pin ~20 m east (simulate drag end)
    pg.evaluate("""() => { const m = []; WellsApp.map.eachLayer(l => { if (l.dragging && l.options.draggable) m.push(l); });
      const k = m[0]; const ll = k.getLatLng(); k.setLatLng([ll.lat, ll.lng + 0.0002]); k.fire('dragend'); }""")
    pg.wait_for_timeout(2500)
    print('gps after drag:', pg.inner_text('#fGps').replace('\n', ' '))
    ok('pin moved' in pg.inner_text('#fGps'), 'drag adjusts pin and records it')
    pg.screenshot(path=out + '-2-form.png')
    pg.click('#fSave'); pg.wait_for_timeout(800)
    sites = pg.evaluate('() => WellsSites.sites.map(s => ({customer: s.customer, apn: s.apn, apnStatus: s.apnStatus, lat: s.lat, lon: s.lon, gps: s.gps, adjusted: s.adjusted, adjustedFt: s.adjustedFt, photoKB: s.photo ? Math.round(s.photo.length*0.75/1024) : 0, addr: s.address, acres: s.parcel && s.parcel.acreage}))')
    print('saved:', json.dumps(sites))
    ok(len(sites) == 1 and sites[0]['apnStatus'] == 'ok' and sites[0]['adjusted'], 'site saved in IndexedDB')
    ok(pg.locator('.site-pin').count() >= 1, 'site pin on map')
    pg.evaluate("() => WellsApp.map.setZoom(17)"); pg.wait_for_timeout(1500)
    pg.locator('#map').screenshot(path=out + '-3-map.png')
    # 4) list + exports
    pg.click('#btnSites'); pg.wait_for_selector('.l-item')
    pg.screenshot(path=out + '-4-list.png')
    dl = {}
    for bid in ['lCsv', 'lKml', 'lJson']:
        with pg.expect_download() as d: pg.click('#' + bid)
        path = os.path.join(root, '.cache', d.value.suggested_filename); d.value.save_as(path); dl[bid] = path
        print('download:', d.value.suggested_filename, os.path.getsize(path), 'bytes')
    print(open(dl['lCsv']).read()[:400])
    kml = open(dl['lKml']).read(); ok('<Placemark>' in kml and 'Polygon' in kml, 'KML has placemark + parcel polygon')
    # import: delete then re-import backup
    pg.evaluate("async () => { for (const s of WellsSites.sites) await WellsSites.Store.del(s.id); await WellsSites.refresh(); }")
    pg.click('#lClose'); pg.click('#btnSites'); pg.set_input_files('#lImport', dl['lJson']); pg.wait_for_timeout(1500)
    ok(pg.evaluate('() => WellsSites.sites.length') == 1, 'import backup restores site')
    # nearby wells for the site
    pg.locator('.l-item .act-wells').first.click(); pg.wait_for_timeout(5000)
    print('wells for site:', pg.inner_text('#status'), '|', pg.inner_text('#summary').split('\n')[0])
    ok('site:' in pg.evaluate('() => WellsApp.state.how'), 'nearby-wells search runs at site coords')
    # 5) offline: capture + save without APN, then back online -> auto lookup
    ctx.set_offline(True)
    dla, dlo = map(float, opt.get('off', '0.0015,0.001').split(','))
    ctx.set_geolocation({'latitude': lat + dla, 'longitude': lon + dlo, 'accuracy': 4})
    pg.click('#btnTag'); pg.wait_for_timeout(2500); pg.click('#gpsCapture')
    pg.wait_for_function("() => /pending/.test(document.getElementById('fParcel').innerText)", timeout=20000)
    pg.fill('#fName', 'Offline Customer'); pg.click('#fSave'); pg.wait_for_timeout(500)
    st = pg.evaluate("() => WellsSites.sites.find(s => s.customer === 'Offline Customer').apnStatus")
    ok(st == 'pending', f'offline save queues APN lookup ({st})')
    pg.screenshot(path=out + '-5-offline.png')
    ctx.set_offline(False); pg.evaluate("() => window.dispatchEvent(new Event('online'))"); pg.wait_for_timeout(5000)
    s2 = pg.evaluate("() => { const s = WellsSites.sites.find(s => s.customer === 'Offline Customer'); return [s.apnStatus, s.apn]; }")
    ok(s2[0] == 'ok' and s2[1], f'queued APN looked up when back online {s2}')
    # privacy: customer data never in any request URL
    leak = [u for u in reqs if name.split()[0] in u or '555-0142' in u or 'Gate' in u]
    ok(not leak, 'no customer data in any network request')
    print('parcel requests:', len([u for u in reqs if 'MapServer/0/query' in u]))
    pg.click('#btnSites'); pg.wait_for_selector('.l-item'); pg.screenshot(path=out + '-6-list2.png')
    b.close()
