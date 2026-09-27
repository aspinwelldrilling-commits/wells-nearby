#!/usr/bin/env python3
"""Measure bytes the app downloads for county WCR data during one lookup (phone viewport, fresh profile).
Usage: /workspace/.venv-pw/bin/python tools/measure_wcr_bytes.py [--base URL] [lat lon r]
Prints per-request transfer size (encoded, i.e. gzip over the wire) and decoded size for data/county-wcr/* requests."""
import sys, os, http.server, threading, functools, argparse
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('coords', nargs='*')
a = ap.parse_args()
lat, lon, r = (a.coords + ['33.0417', '-116.8681', '1'])[:3] if len(a.coords) >= 2 else ('33.0417', '-116.8681', '1')
srv = None
if a.base: base = a.base.rstrip('/') + '/'
else:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); base = f'http://127.0.0.1:{srv.server_address[1]}/'
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 412, 'height': 915}, is_mobile=True, has_touch=True, service_workers='block')
    pg = ctx.new_page(); cdp = ctx.new_cdp_session(pg); cdp.send('Network.enable')
    reqs = {}
    cdp.on('Network.responseReceived', lambda e: reqs.setdefault(e['requestId'], {})
           .update(url=e['response']['url'], status=e['response']['status']))
    cdp.on('Network.loadingFinished', lambda e: reqs.setdefault(e['requestId'], {}).update(enc=e['encodedDataLength']))
    cdp.on('Network.dataReceived', lambda e: reqs.setdefault(e['requestId'], {}).update(dec=reqs.get(e['requestId'], {}).get('dec', 0) + e['dataLength']))
    pg.goto(f'{base}index.html?lat={lat}&lon={lon}&r={r}&view=both')
    pg.wait_for_selector('#summary:not(.hidden)', timeout=90000); pg.wait_for_timeout(3000)
    tot_e = tot_d = 0
    for v in reqs.values():
        u = v.get('url', '')
        if 'county-wcr' not in u: continue
        tot_e += v.get('enc', 0); tot_d += v.get('dec', 0)
        print(f"  {v.get('status')} {v.get('enc', 0):>9,} B wire {v.get('dec', 0):>10,} B decoded  {u.split('county-wcr/')[-1][:60]}")
    print(f'county-wcr total: {tot_e:,} B over the wire, {tot_d:,} B decoded; summary: ' + pg.inner_text('.wcrsum') if pg.locator('.wcrsum').count() else '')
    b.close()
if srv: srv.shutdown()
