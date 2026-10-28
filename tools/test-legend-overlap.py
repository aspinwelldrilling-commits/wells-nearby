#!/usr/bin/env python3
"""Regression test (v28): measurement / setback call-out labels never sit on top of the legend.
On-screen: every .lo-lbl box that intersects the Well Layout map legend (.lo-mapleg) must be hidden behind it -> instead we require
no visible label box intersects the legend box (labels there are nudged clear or the legend is on top & opaque).
Plot plan (PDF/PNG): every call-out pill box (info.labelBoxes) must not intersect the legend box (info.legendBox) nor the
scale-bar / north-arrow boxes. SYNTHETIC data only. Desktop 1920x1080 / 1440x900 + phone 390x844.
Usage: /workspace/.venv-pw/bin/python tools/test-legend-overlap.py [--base URL] [--shots DIR] [--prefix NAME] [--vps desk1920,phone]"""
import sys, os, json, base64, subprocess, http.server, threading, functools, tempfile, argparse
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default=''); ap.add_argument('--prefix', default='legend'); ap.add_argument('--vps', default='')
A = ap.parse_args()
ROOT, BASE, OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))), A.base.rstrip('/') + '/' if A.base else '', A.shots
if not BASE:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); BASE = f'http://127.0.0.1:{srv.server_address[1]}/'
LAT, LON = 33.0400, -116.8700
def P(a, b): return [round(LAT + a, 7), round(LON + b, 7)]
dims = []
for i, (a, b) in enumerate([(1, 1), (1, -1), (-1, 1), (-1, -1)]):   # several measurements near each corner of the view
    for j in range(3):
        dims.append({'id': f'd{i}{j}', 'kind': 'dim', 'pts': [P(a * (0.00055 + 0.00012 * j), b * 0.0011), P(a * (0.00055 + 0.00012 * j), b * 0.0006)]})
LAY = {'app': 'wells-nearby', 'kind': 'septic-layout', 'v': 1, 'id': 'lay_synth_legend', 'name': 'Synthetic Legend Test', 'apn': '000-000-00-00',
  'created': '2026-10-01T10:00:00Z', 'updated': '2026-10-01T10:00:00Z', 'view': {'lat': LAT, 'lon': LON, 'z': 19},
  'opts': {'rings': True, 'sizes': True, 'orientation': 'landscape', 'area': 'view', 'areaPicked': True},
  'meta': {'preparedBy': 'Test', 'date': '2026-10-01', 'notes': 'synthetic'},
  'shapes': [{'id': 's1', 'kind': 'well', 'pts': [P(0.0001, 0.0001)], 'label': 'Existing well'},
    {'id': 's2', 'kind': 'pwell', 'pts': [P(0.0003, -0.0003)]},
    {'id': 's3', 'kind': 'leach', 'pts': [P(-0.0004, -0.0009), P(-0.0004, -0.0002)]},
    {'id': 's4', 'kind': 'tank', 'pts': [P(-0.0003, -0.001)], 'label': '1,500 gal tank'},
    {'id': 's5', 'kind': 'prop', 'closed': True, 'pts': [P(0.0009, -0.0016), P(0.0009, 0.0016), P(-0.0009, 0.0016), P(-0.0009, -0.0016)]}] + dims}
def hit(a, b): return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]
VPS = [('desk1920', 1920, 1080, False), ('desk1440', 1440, 900, False), ('phone', 390, 844, True)]
bad = 0
with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
  for vname, W, H, mob in VPS:
    if A.vps and vname not in A.vps.split(','): continue
    ctx = p.chromium.launch_persistent_context(os.path.join(tmp, vname), executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
        viewport={'width': W, 'height': H}, is_mobile=mob, has_touch=mob, device_scale_factor=1)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda dd: dd.accept())
    pg.goto(f'{BASE}index.html?lat={LAT}&lon={LON}&r=0.25'); pg.wait_for_function('() => window.WellsLayout && WellsLayout.Store', timeout=60000)
    print(vname, 'version', pg.evaluate('() => (window.APP_VERSION || (document.body.innerText.match(/v\\d+/)||[""])[0])'))
    pg.evaluate(f'async () => {{ const n = LayoutCore.normalize({json.dumps(LAY)}); n.opts.sizes = true; n.opts.rings = true; await WellsLayout.Store.put(n); }}')
    pg.evaluate('() => WellsLayout.openList()'); pg.wait_for_selector('.l-item .ll-open'); pg.click('.l-item .ll-open'); pg.wait_for_selector('#loTabs')
    # fit the property lines so the corner measurements sit where the legend / corners are
    pg.evaluate(f'() => WellsApp.map.fitBounds([[{LAT-0.0009},{LON-0.0016}],[{LAT+0.0009},{LON+0.0016}]], {{animate:false, padding:[0,0]}})'); pg.wait_for_timeout(1200)
    # extra measurements placed by screen position: across the legend box and near every corner of the map (and the plan frame)
    pg.evaluate('''() => { const m = WellsApp.map, lg = document.querySelector('.lo-mapleg').getBoundingClientRect(), mr = m.getContainer().getBoundingClientRect(), l = WellsLayout.current;
        const ll = (x, y) => { const q = m.containerPointToLatLng([x - mr.left, y - mr.top]); return [+q.lat.toFixed(7), +q.lng.toFixed(7)]; };
        const add = (x1, y1, x2, y2) => l.shapes.push({ id: 'x' + l.shapes.length, kind: 'dim', pts: [ll(x1, y1), ll(x2, y2)] });
        for (const f of [0.25, 0.5, 0.8]) add(lg.left + 5, lg.top + lg.height * f, lg.right + 30, lg.top + lg.height * f);
        add(lg.left + 10, lg.top + 6, lg.left + 10, lg.bottom - 6);
        const X0 = mr.left + 30, X1 = mr.right - 30, Y0 = mr.top + 30, Y1 = mr.bottom - 30;
        add(X0, Y0, X0 + 90, Y0); add(X1 - 90, Y0, X1, Y0); add(X0, Y1, X0 + 90, Y1); add(X1 - 90, Y1, X1, Y1); add(X1 - 60, Y0 + 20, X1 - 60, Y0 + 90);
        WellsLayout.render(); }''')
    pg.wait_for_timeout(600)
    scr = pg.evaluate('''() => { const lg = document.querySelector('.lo-mapleg'); if (!lg || lg.classList.contains('empty')) return null;
        const R = (r) => [r.left, r.top, r.width, r.height], L = R(lg.getBoundingClientRect()), out = [];
        for (const e of document.querySelectorAll('.lo-lbl')) { const r = e.getBoundingClientRect(); if (!r.width || getComputedStyle(e).visibility === 'hidden') continue;
          const cx = Math.min(Math.max(r.left + r.width / 2, L[0] + 1), L[0] + L[2] - 1), cy = Math.min(Math.max(r.top + r.height / 2, L[1] + 1), L[1] + L[3] - 1);
          out.push({ t: e.textContent, b: R(r), top: (document.elementFromPoint(cx, cy) || {}).closest ? !!document.elementFromPoint(cx, cy).closest('.lo-lbl') : false }); }
        return { leg: L, labels: out }; }''')
    over = [x for x in scr['labels'] if hit(x['b'], scr['leg'])]
    print(f'  screen: legend={[round(v) for v in scr["leg"]]} labels={len(scr["labels"])} overlapping={len(over)} label-on-top={sum(x["top"] for x in over)}')
    if over: bad += 1; print('   ', [x['t'] for x in over][:6])
    if OUT: pg.screenshot(path=f'{OUT}/{A.prefix}-{vname}-screen.png')
    for orient in ['landscape', 'portrait']:
      pg.evaluate('(o) => { WellsLayout.current.opts.orientation = o; }', orient)
      res = pg.evaluate('''async () => { const r = await WellsLayout.makePlan('pdf'); const b = new Uint8Array(await r.blob.arrayBuffer()); let s=''; for (const x of b) s += String.fromCharCode(x);
          return { b64: btoa(s), info: { labelBoxes: r.info.labelBoxes || null, legendBox: r.info.legendBox || null, keepOut: r.info.keepOut || null } }; }''')
      inf = res['info']
      pdf = f'{tmp}/{vname}-{orient}.pdf'; open(pdf, 'wb').write(base64.b64decode(res['b64']))
      if inf['labelBoxes'] is None: print(f'  plan {orient}: no label boxes reported (pre-v28 build)')
      else:
        boxes = [b for b in inf['labelBoxes'] if not b.get('hidden')]
        lo = [b for b in boxes if hit(b['r'], inf['legendBox'])]; ko = [b for b in boxes for k in (inf['keepOut'] or []) if hit(b['r'], k)]
        print(f'  plan {orient}: labels={len(boxes)} on-legend={len(lo)} on-scale/north={len(ko)}')
        if lo or ko: bad += 1
      if OUT: subprocess.run(['pdftoppm', '-png', '-r', '80', '-singlefile', pdf, f'{OUT}/{A.prefix}-{vname}-plan-{orient}'], check=True)
    if errs: bad += 1; print('  errors:', errs[:3])
    ctx.close()
print('ALL PASS' if not bad else f'{bad} FAIL'); sys.exit(1 if bad else 0)
