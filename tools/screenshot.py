"""Headless test: mock geolocation, load app, wait for results, screenshot.
Usage: /workspace/.venv-pw/bin/python tools/screenshot.py [lat lon out.png]"""
import sys, http.server, threading, functools, os
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
lat, lon = (float(sys.argv[1]), float(sys.argv[2])) if len(sys.argv) > 2 else (33.0417, -116.8681)
out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(root, 'screenshot.png')
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
    pg.goto(f'http://127.0.0.1:{port}/index.html')
    pg.wait_for_selector('#summary:not(.hidden)', timeout=60000)
    pg.wait_for_timeout(4000)  # tiles
    print('status:', pg.inner_text('#status'))
    print(pg.inner_text('#summary'))
    print('table rows:', pg.locator('#wellTable tbody tr').count(), '| markers:', pg.locator('.well-pin').count())
    pg.screenshot(path=out, full_page=True)
    # also: popup check
    pg.locator('.well-pin').first.click(); pg.wait_for_timeout(500)
    print('popup:', pg.inner_text('.leaflet-popup-content')[:300].replace('\n', ' | '))
    b.close()
srv.shutdown()
print('saved', out)
