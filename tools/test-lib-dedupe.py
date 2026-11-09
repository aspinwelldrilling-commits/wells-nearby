"""Headless phone (390x844) check: library-only County permits (DEH library, newer than the GIS layer) show their address
in the popup, and a state WCR filed under such a permit is merged into ONE pin (no extra SD state-WCR overlay pin).
Usage: /workspace/.venv-pw/bin/python tools/test-lib-dedupe.py [--base URL] [--shots DIR] [--permits ID,ID]"""
import argparse, functools, http.server, json, os, sys, threading
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('--base'); ap.add_argument('--shots', default='/tmp/lib-dedupe')
ap.add_argument('--permits', default='DEH2026-LWELL-003898,DEH2026-LWELL-003976,DEH2026-LWELL-004012,DEH2026-LWELL-004019,DEH2026-LWELL-004047')
a = ap.parse_args()
os.makedirs(a.shots, exist_ok=True)
base = a.base
if not base:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_address[1]}/'
matched = json.load(open(os.path.join(root, 'data/sd-oswcr/matched.json')))['permits']
fails = []
def check(ok, msg):
    print(('ok   ' if ok else 'FAIL ') + msg)
    if not ok: fails.append(msg)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for pid in a.permits.split(','):
        rec = json.load(open(os.path.join(root, 'data/county-wcr', pid + '.json')))
        lat, lon, addr = rec['lat'], rec['lon'], rec.get('addr')
        wcrs = [m[0] for m in matched.get(pid, [])]
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                            geolocation={'latitude': lat, 'longitude': lon, 'accuracy': 10}, permissions=['geolocation'], service_workers='block')
        pg = ctx.new_page(); errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'{base}index.html?lat={lat}&lon={lon}&r=0.25&view=both&all=1')
        pg.wait_for_selector('#summary:not(.hidden)', timeout=90000)
        pg.evaluate(f'() => WellsApp.map.setView([{lat},{lon}], 17, {{animate:false}})')
        pg.wait_for_timeout(5000)
        r = pg.evaluate('''([pid, wcrs]) => {
          const S = WellsApp.state.shown, refs = S.filter(w => (w.permit && w.permit.toUpperCase() === pid) || (w.county && w.county.permit && w.county.permit.toUpperCase() === pid)
             || (w.match && w.match.county && w.match.county.permit && w.match.county.permit.toUpperCase() === pid) || (w.wcr && wcrs.includes(w.wcr)));
          const mks = new Set(refs.map(w => w._marker).filter(Boolean));
          const sdo = []; WellsApp.map.eachLayer(l => { if (l.sdoWcr && wcrs.includes(l.sdoWcr)) sdo.push(l.sdoWcr); });
          const w = refs.find(x => x._marker); if (w) { WellsApp.map.setView(w._marker.getLatLng(), 17, {animate:false}); w._marker.openPopup(); }
          return { refs: refs.map(x => [x.group, x.permit || (x.county && x.county.permit) || '', x.wcr || '']), markers: mks.size, sdo };
        }''', [pid, wcrs])
        pg.wait_for_timeout(1500)
        listTxt = ''
        if pg.locator('.leaflet-popup .item').count():   # several records on one parcel point: list popup -> open ours
            listTxt = pg.inner_text('.leaflet-popup')
            pg.locator('#map').screenshot(path=os.path.join(a.shots, f'{pid}-list.png'))
            want = wcrs[0] if wcrs else pid
            pg.locator('.leaflet-popup .item', has_text=want).locator('.open-item').first.click(); pg.wait_for_timeout(1500)
        txt = pg.inner_text('.leaflet-popup') if pg.locator('.leaflet-popup').count() else ''
        pg.locator('#map').screenshot(path=os.path.join(a.shots, f'{pid}.png'))
        if listTxt and addr: check(addr.split(',')[0].strip().upper() in listTxt.upper(), f'{pid}: list popup shows address')
        print(pid, 'state WCRs on file:', wcrs, '| app records:', r['refs'])
        check(r['markers'] == 1, f'{pid}: exactly one pin (got {r["markers"]})')
        check(not r['sdo'], f'{pid}: no separate SD state-WCR overlay pin for {wcrs} (got {r["sdo"]})')
        if addr: check(addr.split(',')[0].strip().upper() in txt.upper(), f'{pid}: popup shows address "{addr}"')
        check('Address\t—' not in txt and 'Address —' not in txt, f'{pid}: popup Address is not "—"')
        for wc in wcrs: check(wc in txt, f'{pid}: popup mentions state {wc}')
        check(not errs, f'{pid}: no console errors {errs[:3]}')
        ctx.close()
    b.close()
print('FAILED' if fails else 'all passed', len(fails)); sys.exit(1 if fails else 0)
