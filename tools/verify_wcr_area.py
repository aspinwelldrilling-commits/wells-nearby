#!/usr/bin/env python3
"""Headless phone-viewport check that newly cached county WCR results show up correctly in the app.

For a sample of permits: load the app (412x915 mobile viewport, County view so every permit has a pin) at the permit's parcel point, find the permit among the
shown wells and open its popup. Expected:
  readable permits        -> values tagged "county WCR (OCR ...)" (or state values if a matched state WCR already has depth)
  unreadable/partial/no_wcr -> fluorescent red pin (#FF1744) and "Read this report yourself" with a link to the county doc
                              (or state values if a matched state WCR already has depth)
Usage:
  /workspace/.venv-pw/bin/python tools/verify_wcr_area.py PERMIT[,PERMIT...] [--base https://.../wells-nearby/] [--shots DIR]
Exit code 0 = all checks passed.  Coordinates come from .cache/all-permits.json (tools/build_spiral_plan.py).
"""
import sys, os, json, http.server, threading, functools, argparse
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def local_index():
    """All permits from the local shards (data/county-wcr/tiles/*.json), falling back to the legacy index.json."""
    d = os.path.join(ROOT, 'data', 'county-wcr')
    if os.path.exists(os.path.join(d, 'manifest.json')):
        idx = {}
        for k in json.load(open(os.path.join(d, 'manifest.json')))['tiles']:
            idx.update(json.load(open(os.path.join(d, 'tiles', k + '.json')))['permits'])
        return idx
    return json.load(open(os.path.join(d, 'index.json')))['permits']

JS_FIND = '''(P) => { const s = WellsApp.state.shown;
  const w = s.find(x => x.permit === P) || s.find(x => x.county && x.county.permit === P) || s.find(x => x.match && x.match.county && x.match.county.permit === P);
  if (!w) return {found: false, n: s.length};
  const c = w.group === 'county' ? w : (w.county || (w.match && w.match.county));
  if (w._marker) { WellsApp.map.setView(w._marker.getLatLng(), 16, {animate: false}); w._marker.openPopup(); }
  const pin = w._marker && w._marker.getElement() && w._marker.getElement().querySelector('.well-pin');
  return {found: true, group: w.group, flag: w.wcrFlag, status: c ? c.wcrStatus : null, depth: w.depthFt,
          depthSrc: w.fieldSrc && w.fieldSrc.depthFt ? w.fieldSrc.depthFt.src : null, pinBg: pin ? getComputedStyle(pin).backgroundColor : null,
          pinCls: pin ? pin.className : null, docUrl: w.wcrDocUrl || null};
}'''


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('permits'); ap.add_argument('--base', default=''); ap.add_argument('--shots', default='')
    a = ap.parse_args()
    pts = {p['id'].upper(): p for p in json.load(open(os.path.join(ROOT, '.cache', 'all-permits.json')))}
    idx = local_index()
    permits = [p.strip().upper() for p in a.permits.split(',') if p.strip()]
    srv = None
    if a.base:
        base = a.base.rstrip('/') + '/'
    else:
        class Q(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *x): pass
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{srv.server_address[1]}/'
    fails, results = [], []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=1, is_mobile=True, has_touch=True,
                            geolocation={'latitude': 33.0417, 'longitude': -116.8681, 'accuracy': 10}, permissions=['geolocation'])
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        for P in permits:
            pt = pts.get(P); exp = (idx.get(P) or {}).get('status')
            if not pt or not exp:
                fails.append(f'{P}: no coords or not in index'); continue
            # search at the parcel point; if the app moved the well to a GPS position read from the WCR, retry there
            spots = [(pt['lat'], pt['lon'])]
            g = ((idx.get(P) or {}).get('fields') or {}).get('gps')
            if g and g.get('conf') in ('high', 'medium'): spots.append((g['lat'], g['lon']))
            try:
                for la, lo in spots:
                    pg.goto(f"{base}index.html?lat={la:.6f}&lon={lo:.6f}&r=0.25&view=county&all=1&ts={os.getpid()}", timeout=60000)
                    pg.wait_for_selector('#summary:not(.hidden)', timeout=60000)
                    pg.wait_for_function('(P) => window.WellsCountyWcr && WellsCountyWcr.index && WellsCountyWcr.index[P]', arg=P, timeout=30000)
                    pg.wait_for_timeout(1500)
                    r = pg.evaluate(JS_FIND, P)
                    if r['found']: break
                pg.wait_for_timeout(800)
                # grouped marker ("N records at this point"): open this permit's own popup from the list
                item = pg.locator('.leaflet-popup .item .open-item', has_text=P)
                if item.count():
                    item.first.click(); pg.wait_for_timeout(800)
                html = pg.inner_html('.leaflet-popup-content') if pg.locator('.leaflet-popup-content').count() else ''
            except Exception as e:
                fails.append(f'{P}: page error {str(e)[:150]}'); continue
            r.update(permit=P, expected=exp)
            ok, why = True, ''
            if not r['found']:
                ok, why = False, 'permit not shown in app'
            elif r['status'] != exp:
                ok, why = False, f"app status {r['status']} != index {exp}"
            elif r['flag'] == 'state':
                why = 'state WCR already has depth (OCR not needed)'
            elif exp == 'readable':
                ok = r['flag'] == 'ocr' and 'county WCR (OCR' in html
                why = 'OCR values tagged in popup' if ok else f"expected OCR tag, flag={r['flag']}"
            elif exp in ('unreadable', 'partial', 'no_wcr', 'no_docs', 'error'):
                red = r['flag'] == 'read' and 'Read this report yourself' in html
                link = exp in ('no_docs',) or ('file.sandiegocounty.gov' in html and 'readbtn' in html)
                pinred = r['pinBg'] == 'rgb(255, 23, 68)' or 'pin-somered' in (r['pinCls'] or '')
                ok = red and link and pinred
                why = 'red + WCR link' if ok else f"red={red} link={link} pin={r['pinBg']} {r['pinCls']}"
            r['ok'], r['why'] = ok, why
            results.append(r)
            print(('PASS ' if ok else 'FAIL ') + f"{P} [{exp}] flag={r.get('flag')} {why}", flush=True)
            if not ok: fails.append(f'{P}: {why}')
            if a.shots:
                os.makedirs(a.shots, exist_ok=True); pg.screenshot(path=os.path.join(a.shots, P + '.png'))
        b.close()
    if srv: srv.shutdown()
    if errs: print('page errors:', errs[:5])
    print(f'{len(results) - len([x for x in results if not x["ok"]])}/{len(permits)} passed')
    if fails: print('FAILURES:', *fails, sep='\n  ')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
