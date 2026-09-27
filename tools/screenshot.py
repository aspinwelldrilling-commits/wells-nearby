"""Headless test: mock geolocation, load app, wait for results, screenshot.
Usage: /workspace/.venv-pw/bin/python tools/screenshot.py [lat lon out.png]"""
import sys, http.server, threading, functools, os
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
lat, lon = (float(sys.argv[1]), float(sys.argv[2])) if len(sys.argv) > 2 else (33.0417, -116.8681)
out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(root, 'screenshot.png')
view = sys.argv[4] if len(sys.argv) > 4 else ''
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
H = functools.partial(Q, directory=root)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=1, is_mobile=True, has_touch=True,
                        geolocation={'latitude': lat, 'longitude': lon, 'accuracy': 10}, permissions=['geolocation'])
    pg = ctx.new_page()
    pg.on('console', lambda m: print('console:', m.type, m.text) if m.type in ('error', 'warning') else None)
    pg.goto(f'http://127.0.0.1:{port}/index.html' + (f'?view={view}' if view else ''))
    pg.wait_for_selector('#summary:not(.hidden)', timeout=60000)
    pg.wait_for_timeout(4000)  # tiles
    print('status:', pg.inner_text('#status'))
    print(pg.inner_text('#summary'))
    print('table rows:', pg.locator('#wellTable tbody tr').count(), '| markers:', pg.locator('.well-pin').count())
    pg.screenshot(path=out, full_page=True)
    # also: popup check (prefer a merged/county pin) + close-up of map with popup
    pg.evaluate('() => WellsApp.map.setZoom(15, {animate: false})'); pg.wait_for_timeout(2500)
    pg.locator('#map').screenshot(path=out.replace('.png', '-map.png'))
    pg.evaluate('''() => { const s = WellsApp.state.shown;
      const w = s.find(x => x.group === 'both' && x.county && /LWELL-0/.test(x.county.permit)) || s.find(x => x.group === 'both' && x.depthFt) || s.find(x => x.group === 'both') || s[0];
      if (w && w._marker) { WellsApp.map.setView(w._marker.getLatLng(), 15, {animate: false}); w._marker.openPopup(); } }''')
    try: pg.wait_for_selector('.leaflet-popup .doclist, .leaflet-popup .docs .bad, .leaflet-popup .docs-body div.muted', timeout=40000)
    except Exception as e: print('docs wait:', e)
    pg.evaluate("() => { const d = document.querySelector('.leaflet-popup .docs'); if (d) d.scrollIntoView(); }")
    pg.wait_for_timeout(1500)
    print('docs:', (pg.inner_text('.leaflet-popup .docs') if pg.locator('.leaflet-popup .docs').count() else 'none').replace('\n', ' | '))
    print('popup:', pg.inner_text('.leaflet-popup-content')[:400].replace('\n', ' | '))
    pg.locator('#map').screenshot(path=out.replace('.png', '-popup.png'))
    b.close()
srv.shutdown()
print('saved', out)
