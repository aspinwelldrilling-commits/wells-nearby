#!/usr/bin/env python3
"""Regression test (v30): every GPS readout also shows labeled latitude / longitude ("Lat 33.040000° N · Lon 116.870000° W").
Surfaces: map tap popup, search-point popup, 🔍 GPS search pin popup, proposed well site popup + My sites list, Well Layout list,
Well Layout 🖨 Plan tab, plot plan PDF title block (GPS field + labeled line + dedicated "Latitude: … Longitude: …" line).
SYNTHETIC data only (fake customer, fake APN). Phone 390x844 (primary) + desktop 1920x1080.
Usage: /workspace/.venv-pw/bin/python tools/test-latlon-display.py [--base URL] [--shots DIR] [--prefix NAME] [--vps phone,desk1920]"""
import sys, os, re, json, base64, subprocess, http.server, threading, functools, tempfile, argparse
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default=''); ap.add_argument('--prefix', default='latlon'); ap.add_argument('--vps', default='')
A = ap.parse_args()
ROOT, BASE, OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))), A.base.rstrip('/') + '/' if A.base else '', A.shots
if not BASE:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); BASE = f'http://127.0.0.1:{srv.server_address[1]}/'
LAT, LON = 33.0400, -116.8700
def P(a, b): return [round(LAT + a, 7), round(LON + b, 7)]
SITE = {'id': 'site_synth_ll', 'customer': 'Test Customer (synthetic)', 'phone': '555-0100', 'apn': '000-000-00-00', 'apnStatus': 'ok',
        'lat': 33.040321, 'lon': -116.869654, 'gps': {'accuracyFt': 9}, 'notes': 'synthetic', 'created': '2026-10-01T10:00:00Z', 'updated': '2026-10-01T10:00:00Z'}
LAY = {'app': 'wells-nearby', 'kind': 'septic-layout', 'v': 1, 'id': 'lay_synth_ll', 'name': 'Test Customer (synthetic)', 'apn': '000-000-00-00', 'address': '1 Test Rd',
  'siteId': 'site_synth_ll', 'created': '2026-10-01T10:00:00Z', 'updated': '2026-10-01T10:00:00Z', 'view': {'lat': LAT, 'lon': LON, 'z': 19},
  'opts': {'rings': True, 'sizes': True, 'orientation': 'landscape', 'area': 'view', 'areaPicked': True},
  'meta': {'preparedBy': 'Test', 'date': '2026-10-01', 'notes': 'synthetic'},
  'shapes': [{'id': 's1', 'kind': 'well', 'pts': [P(0.0001, 0.0002)], 'label': 'Existing well'},
    {'id': 's2', 'kind': 'pwell', 'pts': [[33.040321, -116.869654]]},
    {'id': 's3', 'kind': 'leach', 'pts': [P(-0.0004, -0.0009), P(-0.0004, -0.0002)]},
    {'id': 's4', 'kind': 'tank', 'pts': [P(-0.0003, -0.001)], 'label': '1,500 gal tank'},
    {'id': 's5', 'kind': 'prop', 'closed': True, 'pts': [P(0.0009, -0.0016), P(0.0009, 0.0016), P(-0.0009, 0.0016), P(-0.0009, -0.0016)]}]}
LBL = re.compile(r'Lat \d{1,2}\.\d{6}° [NS]\s+(·\s+)?Lon \d{1,3}\.\d{6}° [EW]')
VPS = [('phone', 390, 844, True), ('desk1920', 1920, 1080, False)]
bad = []
def check(name, txt, orig):
    ok_o, ok_l = bool(re.search(orig, txt)), bool(LBL.search(txt))
    print(f'  {"PASS" if ok_o and ok_l else "FAIL"} {name}: original={ok_o} labeled={ok_l} | {" ".join(txt.split())[:150]}')
    if not (ok_o and ok_l): bad.append(name)
def shot(pg, name, sel=None):
    if not OUT: return
    pg.screenshot(path=f'{OUT}/{A.prefix}-{name}.png')
    if sel:
        try: pg.locator(sel).first.screenshot(timeout=4000, path=f'{OUT}/{A.prefix}-{name}-zoom.png')
        except Exception as e: print('   (no zoom shot)', e)
with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
  for vname, W, H, mob in VPS:
    if A.vps and vname not in A.vps.split(','): continue
    ctx = p.chromium.launch_persistent_context(os.path.join(tmp, vname), executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
        viewport={'width': W, 'height': H}, is_mobile=mob, has_touch=mob, device_scale_factor=2 if mob else 1)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda dd: dd.accept())
    pg.goto(f'{BASE}index.html?lat={LAT}&lon={LON}&r=0.25'); pg.wait_for_function('() => window.WellsLayout && WellsLayout.Store && window.WellsSites', timeout=60000)
    print(vname, 'version', pg.evaluate("() => (document.body.innerText.match(/\\bv\\d\\d\\b/)||[''])[0]"), 'sw', pg.evaluate("() => fetch('sw.js',{cache:'no-store'}).then(r=>r.text()).then(t=>(t.match(/shell-(v\\d+)/)||[])[1])"))
    pg.wait_for_timeout(2500)
    def popup_txt(): return pg.inner_text('.leaflet-popup-content') if pg.locator('.leaflet-popup-content').count() else ''
    # 1) search point popup
    pg.evaluate("() => { const m = document.querySelector('.me-pin'); if (m) m.click(); }"); pg.wait_for_timeout(700)
    check(f'{vname} search-point popup', popup_txt(), r'33\.040000, -116\.870000'); shot(pg, f'{vname}-searchpoint', '.leaflet-popup')
    # 2) map tap popup
    pg.evaluate("() => { WellsApp.map.closePopup(); WellsApp.map.fire('click', { latlng: L.latLng(33.04123, -116.87234), containerPoint: L.point(100,100), originalEvent: new MouseEvent('click') }); }"); pg.wait_for_timeout(900)
    check(f'{vname} map-tap popup', popup_txt(), r'33\.04123, -116\.87234'); shot(pg, f'{vname}-maptap', '.leaflet-popup')
    # 3) 🔍 GPS search
    pg.evaluate("() => WellsApp.map.closePopup()")
    pg.fill('.as-input', '33.03812, -116.86543'); pg.press('.as-input', 'Enter'); pg.wait_for_timeout(2500)
    pg.evaluate("() => { const m = document.querySelector('.as-pin'); if (m) m.click(); }"); pg.wait_for_timeout(700)
    check(f'{vname} GPS-search pin popup', popup_txt(), r'33\.03812, -116\.86543'); shot(pg, f'{vname}-gpssearch', '.leaflet-popup')
    pg.evaluate("() => WellsApp.map.closePopup()")
    # 4) proposed well site: popup + list
    pg.evaluate(f"async () => {{ await WellsSites.Store.put({json.dumps(SITE)}); await WellsSites.refresh(); }}"); pg.wait_for_timeout(500)
    pg.evaluate("() => WellsSites.showOnMap(WellsSites.sites.find(s => s.id === 'site_synth_ll'))"); pg.wait_for_timeout(1500)
    check(f'{vname} site popup', popup_txt(), r'33\.040321, -116\.869654'); shot(pg, f'{vname}-sitepopup', '.leaflet-popup')
    pg.evaluate("() => { WellsApp.map.closePopup(); WellsSites.openList(); }"); pg.wait_for_timeout(800)
    check(f'{vname} My sites list', pg.inner_text('#listBody'), r'33\.040321, -116\.869654'); shot(pg, f'{vname}-sitelist', '#listBody .l-item')
    check(f'{vname} site share text', pg.evaluate("() => WellsSites.summaryText(WellsSites.sites.find(s => s.id === 'site_synth_ll'))"), r'GPS: 33\.040321, -116\.869654')
    pg.evaluate("() => WellsSites.closeSheet && WellsSites.closeSheet()")
    # 5) Well Layout: list, Plan tab, PDF
    pg.evaluate(f"async () => {{ await WellsLayout.Store.put(LayoutCore.normalize({json.dumps(LAY)})); }}")
    pg.evaluate('() => WellsLayout.openList()'); pg.wait_for_selector('.l-item .ll-open'); pg.wait_for_timeout(400)
    check(f'{vname} Well Layout list', pg.inner_text('.l-item'), r'33\.040321, -116\.869654'); shot(pg, f'{vname}-layoutlist', '.l-item')
    pg.click('.l-item .ll-open'); pg.wait_for_selector('#loTabs'); pg.wait_for_timeout(1500)
    pg.click('#loTabs [data-t="plan"]'); pg.wait_for_timeout(600)
    tab = pg.inner_text('#loGps') if pg.locator('#loGps').count() else pg.inner_text('.sheet') if pg.locator('.sheet').count() else ''
    check(f'{vname} Well Layout Plan tab', tab, r'33\.040321, -116\.869654'); shot(pg, f'{vname}-layoutplan', '#loGps')
    for orient in ['landscape', 'portrait']:
      pg.evaluate('(o) => { WellsLayout.current.opts.orientation = o; }', orient)
      res = pg.evaluate('''async () => { const r = await WellsLayout.makePlan('pdf'); const b = new Uint8Array(await r.blob.arrayBuffer()); let s=''; for (const x of b) s += String.fromCharCode(x);
          return { b64: btoa(s), ll: r.info.latLon || null, leg: r.info.legendBox || null }; }''')
      ll = res['ll'] or {}
      line = ll.get('line', '')
      ok = bool(re.fullmatch(r'Latitude: 33\.040321° N   Longitude: 116\.869654° W', line))
      print(f'  {"PASS" if ok else "FAIL"} {vname} plot plan {orient}: dedicated line={line!r} src={ll.get("src")}')
      if not ok: bad.append(f'{vname} plan {orient}')
      pdf = f'{tmp}/{vname}-{orient}.pdf'; open(pdf, 'wb').write(base64.b64decode(res['b64']))
      if OUT:
        subprocess.run(['pdftoppm', '-png', '-r', '110', '-singlefile', pdf, f'{OUT}/{A.prefix}-{vname}-plan-{orient}'], check=True)
        # zoom on the title block (right panel in landscape, bottom in portrait)
        from PIL import Image
        im = Image.open(f'{OUT}/{A.prefix}-{vname}-plan-{orient}.png'); w, h = im.size
        (im.crop((int(w * 0.70), 0, w, int(h * 0.55))) if orient == 'landscape' else im.crop((0, int(h * 0.62), int(w * 0.55), h))).save(f'{OUT}/{A.prefix}-{vname}-plan-{orient}-zoom.png')
    if errs: bad.append(f'{vname} page errors'); print('  errors:', errs[:3])
    ctx.close()
print('ALL PASS' if not bad else f'{len(bad)} FAIL: {bad}'); sys.exit(1 if bad else 0)
