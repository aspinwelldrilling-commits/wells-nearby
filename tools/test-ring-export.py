#!/usr/bin/env python3
"""Regression test (v27): the plot plan PDF draws exactly the setback rings shown on the map (map ◎ ring boxes for existing 'e' and
proposed 'p' wells, 150/100/50 ft each, plus the layout's ◎ Setback rings option), and its legend lists only drawn rings.
Uses a SYNTHETIC layout saved in the older record format (no area option, stray legacy opts.setbackRings). Desktop 1920/1440 + phone.
Usage: /workspace/.venv-pw/bin/python tools/test-ring-export.py [--base URL] [--shots DIR] [--prefix NAME] [--vps desk1920,phone]"""
import sys, os, json, base64, subprocess, http.server, threading, functools, tempfile, argparse
from playwright.sync_api import sync_playwright
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--shots', default=''); ap.add_argument('--prefix', default='ring'); ap.add_argument('--vps', default='')
A = ap.parse_args()
ROOT, PREFIX, BASE, OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))), A.prefix, A.base.rstrip('/') + '/' if A.base else '', A.shots
if not BASE:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); BASE = f'http://127.0.0.1:{srv.server_address[1]}/'
LAT, LON = 33.0400, -116.8700
d = 0.00025
OLD = {  # older-format saved record: no area/areaPicked/warnings, plus a stray legacy setbackRings flag
  'app': 'wells-nearby', 'kind': 'septic-layout', 'v': 1, 'id': 'lay_synth_old', 'name': 'Synthetic Test Job #2', 'apn': '000-000-00-00',
  'created': '2026-09-01T10:00:00Z', 'updated': '2026-09-01T10:00:00Z', 'view': {'lat': LAT, 'lon': LON, 'z': 19},
  'opts': {'rings': True, 'sizes': True, 'orientation': 'landscape', 'setbackRings': {'150': True, '100': True, '50': True}},
  'meta': {'preparedBy': 'Test', 'date': '2026-09-01', 'notes': 'synthetic'},
  'shapes': [
    {'id': 's1', 'kind': 'well', 'pts': [[LAT, LON]]},
    {'id': 's2', 'kind': 'pwell', 'pts': [[LAT + 0.0009, LON + 0.0011]]},
    {'id': 's3', 'kind': 'leach', 'pts': [[LAT - 0.0008, LON - 0.0012], [LAT - 0.0008, LON - 0.0004]]},
    {'id': 's4', 'kind': 'tank', 'pts': [[LAT - 0.0006, LON - 0.0013]]},
    {'id': 's5', 'kind': 'house', 'pts': [[LAT - d, LON + d], [LAT - d, LON + 3*d], [LAT - 3*d, LON + 3*d], [LAT - 3*d, LON + d]]}]}
SC = [('allon', {}), ('e150off', {'e': [150]}), ('e100off', {'e': [100]}), ('e50off', {'e': [50]}), ('p150off', {'p': [150]}),
      ('p100off', {'p': [100]}), ('p50off', {'p': [50]}), ('alloff', {'e': [150, 100, 50], 'p': [150, 100, 50]}), ('both150off', {'e': [150], 'p': [150]}), ('optoff', {}), ('fit-e150off', {'e': [150]})]
VPS = [('desk1920', 1920, 1080, False), ('desk1440', 1440, 900, False), ('phone', 390, 844, True)]
only = A.vps; bad = 0
with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
  for vname, W, H, mob in VPS:
    if only and vname not in only.split(','): continue
    ctx = p.chromium.launch_persistent_context(os.path.join(tmp, vname), executable_path='/usr/bin/google-chrome', args=['--no-sandbox'],
        viewport={'width': W, 'height': H}, is_mobile=mob, has_touch=mob, device_scale_factor=1)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda dd: dd.accept())
    pg.goto(f'{BASE}index.html?lat={LAT}&lon={LON}&r=0.25'); pg.wait_for_function('() => window.WellsLayout && WellsLayout.Store', timeout=60000)
    print(vname, 'version', pg.evaluate('() => (document.body.innerText.match(/v\\d+/)||[""])[0]'))
    pg.evaluate(f'async () => {{ const o = {json.dumps(OLD)}; const n = LayoutCore.normalize(o); n.opts = {{...o.opts, ...{{}}}}; n.opts.sizes = true; await WellsLayout.Store.put(n); }}')
    pg.evaluate('() => WellsLayout.openList()'); pg.wait_for_selector('.l-item .ll-open'); pg.click('.l-item .ll-open'); pg.wait_for_selector('#loTabs')
    pg.evaluate(f'() => WellsApp.map.setView([{LAT+0.0002}, {LON-0.0001}], 19, {{animate:false}})'); pg.wait_for_timeout(800)
    for name, off in SC:
      pg.evaluate('''(off) => { for (const g of ['e','p']) for (const ft of [150,100,50]) { const want = !((off[g]||[]).includes(ft));
          const i = document.querySelector(`.ring-tg input[data-grp="${g}"][data-ft="${ft}"]`); if (i.checked !== want) { i.checked = want; i.dispatchEvent(new Event('change', {bubbles:true})); } } }''', off)
      pg.evaluate('(on) => { const i = document.getElementById("loRings"); if (i && i.checked !== on) { i.checked = on; i.dispatchEvent(new Event("change", {bubbles:true})); } }', name != 'optoff')
      pg.evaluate('(f) => { const l = WellsLayout.current; l.opts.area = f ? "fit" : "view"; l.opts.areaPicked = f; }', name.startswith('fit'))
      pg.wait_for_timeout(400)
      screen = pg.evaluate('''() => { const r = []; WellsApp.map.eachLayer(l => { if (l instanceof L.Circle && l.options.interactive === false && l.options.fill === false) r.push(Math.round(l.getRadius()*3.28084)); }); return r.sort((a,b)=>a-b); }''')
      res = pg.evaluate('''async () => { const K = window.SepticCore, oc = K.circle, seen = []; K.circle = function (w, ft, n) { if (n === 120) seen.push({ ft }); return oc.apply(this, arguments); };
          let r; try { r = await WellsLayout.makePlan('pdf'); } finally { K.circle = oc; } const b = new Uint8Array(await r.blob.arrayBuffer()); let s=''; for (const x of b) s += String.fromCharCode(x);
          return { b64: btoa(s), rings: seen, legend: r.info.legendRings || null }; }''')
      pdf = f'{OUT or tmp}/{PREFIX}-{vname}-{name}.pdf'; open(pdf, 'wb').write(base64.b64decode(res['b64']))
      ok_pdf = open(pdf,'rb').read(5) == b'%PDF-'
      if not ok_pdf: bad += 1; print('  not a PDF')
      if OUT:
       subprocess.run(['pdftoppm', '-png', '-r', '60', '-singlefile', pdf, pdf[:-4] + '-pdf'], check=True); 
       pg.locator('#map').screenshot(path=f'{OUT}/{PREFIX}-{vname}-{name}-screen.png')
       from PIL import Image
       ims = [Image.open(x) for x in (f'{OUT}/{PREFIX}-{vname}-{name}-screen.png', pdf[:-4] + '-pdf.png')]
       ims = [i.resize((int(i.width * 660 / i.height), 660)) for i in ims]; sb = Image.new('RGB', (sum(i.width for i in ims) + 20, 660), 'white')
       sb.paste(ims[0], (0, 0)); sb.paste(ims[1], (ims[0].width + 20, 0)); sb.save(f'{OUT}/{PREFIX}-{vname}-{name}-sidebyside.png')
      os.remove(pdf); pr = sorted(x['ft'] for x in res['rings']) if res['rings'] is not None else None
      exp_leg = sorted(set(screen)); ok = pr is not None and pr == screen and sorted(res['legend'] or []) == exp_leg
      if not ok: bad += 1
      print(f'  {name:8} screen={screen} pdf={pr} legend={res["legend"]} {"OK" if ok else "MISMATCH"}')
    if errs: bad += 1
    print('  errors:', errs[:3]); ctx.close()
print('MISMATCHES', bad); print('ALL PASS' if not bad else f'{bad} FAIL'); sys.exit(1 if bad else 0)
