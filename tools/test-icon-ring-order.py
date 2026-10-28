#!/usr/bin/env python3
"""Regression test (v29): setback rings (50 / 100 / 150 ft) never cover the feature icons (well, proposed well, septic tank …).
Map: rings are in their own pane under the layout drawing pane and the marker pane (icons); ring call-outs are slid round the ring
clear of icons. Plot plan: rings drawn first, then lines / areas, then icons, then call-outs; no ring call-out box on an icon;
pixels around each icon centre are the icon colour on screen and in the plan. SYNTHETIC layout (no customer data), icons placed
exactly on rings. Desktop 1920/1440 + phone.  Usage: /workspace/.venv-pw/bin/python tools/test-icon-ring-order.py [--base URL]"""
import sys, os, io, json, http.server, threading, functools, tempfile, argparse, base64
from playwright.sync_api import sync_playwright
from PIL import Image
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); A = ap.parse_args()
ROOT, BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__))), A.base.rstrip('/') + '/' if A.base else ''
if not BASE:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); BASE = f'http://127.0.0.1:{srv.server_address[1]}/'
LAT, LON = 33.0400, -116.8700
BUILD = '''() => { const K = SepticCore, pj = K.projector(%f, %f), F = 0.3048, at = (e, n) => { const p = pj.inv(e*F, n*F); return [+p[0].toFixed(7), +p[1].toFixed(7)]; };
 const s = [
  {id:'w', kind:'well', pts:[at(0,0)]},
  {id:'pw', kind:'pwell', pts:[at(0,100)]},            // on the existing well's 100 ft ring, exactly at its label spot
  {id:'tk', kind:'tank', pts:[at(-150,0)]},            // on the 150 ft ring
  {id:'lc', kind:'leach', pts:[at(-170,-60), at(-170,-140)]},
  {id:'tl', kind:'tight', pts:[at(-150,0), at(-170,-60)]},
  {id:'sw', kind:'sewer', pts:[at(-60,-40), at(-150,0)]},
  {id:'hs', kind:'house', pts:[at(-60,-20), at(-20,-20), at(-20,-60), at(-60,-60)]},
  {id:'pl', kind:'prop', closed:true, pts:[at(-220,180), at(160,180), at(160,-180), at(-220,-180)]}];
 return { app:'wells-nearby', kind:'septic-layout', v:1, id:'lay_synth_icon', name:'Synthetic Icon Test', apn:'000-000-00-00', created:'2026-10-01T00:00:00Z', updated:'2026-10-01T00:00:00Z',
   view:{lat:%f, lon:%f, z:19}, opts:{rings:true, sizes:true, orientation:'landscape'}, meta:{preparedBy:'Test', date:'2026-10-01', notes:'synthetic'}, shapes:s }; }''' % (LAT, LON, LAT, LON)
VPS = [('desk1920', 1920, 1080, False), ('desk1440', 1440, 900, False), ('phone', 390, 844, True)]
hexrgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
near = (lambda a, b, tol=60: sum(abs(x - y) for x, y in zip(a[:3], b)) <= tol)
def icon_px_ok(im, x, y, col, d):
    # ring of 8 samples inside the icon disc (the centre itself carries the W / PW / ST letters): most must be the icon colour
    import math
    pts = [(x + d * math.cos(a * math.pi / 4), y + d * math.sin(a * math.pi / 4)) for a in range(8)]
    got = [im.getpixel((int(px), int(py))) for px, py in pts]; ok = sum(near(g, col, 90) for g in got) >= 3 and not any(near(g, rc, 60) for g in got for rc in RING_COLS if not near(rc, col, 60))
    if not ok: print("    px", col, got)
    return ok
RING_COLS = [hexrgb(c) for c in ('#a855f7', '#f97316', '#ef4444')]   # SepticCore.RINGS 50 / 100 / 150 ft
bad = 0
def check(name, ok, extra=''):
    global bad
    if not ok: bad += 1
    print(f'  {"OK  " if ok else "FAIL"} {name} {extra}')
with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
  for vname, W, H, mob in VPS:
    ctx = p.chromium.launch_persistent_context(os.path.join(tmp, vname), executable_path='/usr/bin/google-chrome', args=['--no-sandbox'], viewport={'width': W, 'height': H}, is_mobile=mob, has_touch=mob)
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: d.accept())
    pg.goto(f'{BASE}index.html?lat={LAT + 0.003}&lon={LON}&r=0.25')   # search pin off the job (it is not part of the layout); pg.wait_for_function('() => window.WellsLayout && WellsLayout.Store', timeout=60000)
    print(vname)
    pg.evaluate(f'async () => {{ const o = ({BUILD})(); const n = LayoutCore.normalize(o); n.opts = o.opts; await WellsLayout.Store.put(n); }}')
    pg.evaluate('() => WellsLayout.openList()'); pg.wait_for_selector('.l-item .ll-open'); pg.click('.l-item .ll-open'); pg.wait_for_selector('#loTabs')
    pg.evaluate(f'() => WellsApp.map.setView([{LAT}, {LON - 0.0002}], 19, {{animate:false}})'); pg.wait_for_timeout(2500)
    m = pg.evaluate('''() => { const map = WellsApp.map, z = (n) => +getComputedStyle(map.getPane(n)).zIndex, rings = [], icons = [];
        map.eachLayer((l) => { if (l instanceof L.Circle && l.options.fill === false && l.options.interactive === false) rings.push(l.options.pane || (l.options.renderer && l.options.renderer.options.pane)); });
        for (const s of WellsLayout.current.shapes) if (['well','pwell','tank'].includes(s.kind)) { const q = map.latLngToContainerPoint(s.pts[0]); icons.push({ kind: s.kind, x: q.x, y: q.y }); }
        const ptPanes = [...document.querySelectorAll('.lo-pt')].map((e) => e.closest('.leaflet-pane').className);
        const ringLbl = [...document.querySelectorAll('.lo-lbl.lo-ring')].map((e) => { const r = e.getBoundingClientRect(), c = map.getContainer().getBoundingClientRect(); return [r.left - c.left, r.top - c.top, r.width, r.height]; });
        return { ringZ: z('layoutRingPane'), drawZ: z('layoutPane'), markerZ: z('markerPane'), rings, icons, ptPanes, ringLbl }; }''')
    check('map: ring pane below drawing pane below icon pane', m['ringZ'] < m['drawZ'] < m['markerZ'], f"{m['ringZ']} < {m['drawZ']} < {m['markerZ']}")
    check('map: every ring in layoutRingPane', len(m['rings']) == 6 and all(x == 'layoutRingPane' for x in m['rings']), str(m['rings']))
    check('map: icons in markerPane', m['ptPanes'] and all('leaflet-marker-pane' in c for c in m['ptPanes']))
    hit = [(i['kind'], b) for i in m['icons'] for b in m['ringLbl'] if b[0] - 15 < i['x'] < b[0] + b[2] + 15 and b[1] - 15 < i['y'] < b[1] + b[3] + 15]
    check('map: no ring call-out on an icon', not hit, str(hit))
    shot = Image.open(io.BytesIO(pg.locator('#map').screenshot())).convert('RGB')
    cols = pg.evaluate('() => Object.fromEntries(WellsLayout.current.shapes.filter((s) => ["well","pwell","tank"].includes(s.kind)).map((s) => [s.kind, LayoutCore.styleOf(WellsLayout.current, s).color]))')
    for i in m['icons']: check(f"map pixels: {i['kind']} icon not ring-coloured", icon_px_ok(shot, i['x'], i['y'], hexrgb(cols[i['kind']]), 7))
    r = pg.evaluate('''async () => { const { canvas, info } = await WellsLayout.renderPlan(WellsLayout.current); return { png: canvas.toDataURL('image/png'), info }; }''')
    info = r['info']; order = info['drawOrder']; plan = Image.open(io.BytesIO(base64.b64decode(r['png'].split(',')[1]))).convert('RGB')
    first_other = next(i for i, x in enumerate(order) if x != 'ring'); last_pt = max(i for i, x in enumerate(order) if x == 'point')
    check('plan: rings drawn before every feature', 'ring' not in order[first_other:], f"{order.count('ring')} rings")
    check('plan: icons drawn after lines/areas, call-outs after icons', all(x in ('point', 'text') for x in order[order.index('point'):order.index('label')]) and 'point' not in order[order.index('label'):])
    rl = [b['r'] for b in info['labelBoxes'] if b['t'].endswith(' ft') and b['t'].split()[0] in ('50', '100', '150')]
    hit = [(i['kind'], b) for i in info['icons'] for b in rl if b[0] - 12 < i['x'] < b[0] + b[2] + 12 and b[1] - 12 < i['y'] < b[1] + b[3] + 12]
    check('plan: no ring call-out on an icon', len(rl) == 6 and not hit, str(hit))
    for i in info['icons']: check(f"plan pixels: {i['kind']} icon not ring-coloured", icon_px_ok(plan, i['x'], i['y'], hexrgb(i['color']), 0.78 * i['r']))
    check('no page errors', not errs, str(errs[:2])); ctx.close()
print('ALL PASS' if not bad else f'{bad} FAIL'); sys.exit(1 if bad else 0)
