#!/usr/bin/env python3
"""Headless phone test of the private My Jobs layer (js/myjobs.js). By default it builds a SYNTHETIC Google Earth export
(fake jobs, no real customer data) in a temp dir: import .kmz -> pins + drawings + counts, persists after reload, matched
.json import (confidence colours + permit links), remove from device, nothing about the jobs sent to any server, APN search
still works, 0 page errors.
Usage: /workspace/.venv-pw/bin/python tools/test-myjobs.py [--base URL] [--file my.kmz --expect N] [--json my-jobs.json]
       [--shots DIR]   (--file/--json: a real export; keep it OFF the repo — it is private)"""
import sys, os, http.server, threading, functools, argparse, tempfile, json, zipfile, math, re
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser(); ap.add_argument('--base', default=''); ap.add_argument('--file', default=''); ap.add_argument('--expect', type=int, default=0)
ap.add_argument('--json', default=''); ap.add_argument('--shots', default=''); a = ap.parse_args()
srv = None
if a.base: base = a.base.rstrip('/') + '/'
else:
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *x): pass
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start(); base = f'http://127.0.0.1:{srv.server_address[1]}/'
fails = []
def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg, flush=True)
    if not ok: fails.append(msg)

def circle(lat, lon, r_m, n=36):
    pts = []
    for i in range(n + 1):
        t = 2 * math.pi * i / n
        pts.append((lon + r_m * math.sin(t) / (111320 * math.cos(math.radians(lat))), lat + r_m * math.cos(t) / 111320))
    return ' '.join(f'{x:.7f},{y:.7f},0' for x, y in pts)
def pm(name, coords, style='#s1'):
    return f'<Placemark><name>{name}</name><styleUrl>{style}</styleUrl><LineString><tessellate>1</tessellate><coordinates>{coords}</coordinates></LineString></Placemark>'
def synthetic(tmp):
    """3 year folders, 6 jobs (1 duplicate, 1 empty, 1 destruction, 1 with no well drawn), all fake names."""
    J = [('Drilling 2021', 'Testjob Alpha 100 Fake Rd', 33.0400, -116.8700, 'proposed well'),
         ('Drilling 2021', 'Testjob Bravo', 33.0450, -116.8600, 'proposed well'),
         ('Drilling 2022', 'Testjob Charlie well destruction', 33.0100, -116.9000, 'existing well'),
         ('Drilling 2023', 'Testjob Delta', 32.9900, -116.8000, None)]
    folders = {}
    for y, n, la, lo, wn in J:
        body = (pm(wn, circle(la, lo, 0.6)) if wn else '') + pm('100 foot radius', circle(la, lo, 30.48), '#s2') + pm('44 feet from east pl', f'{lo:.7f},{la:.7f},0 {lo + 0.00015:.7f},{la:.7f},0')
        folders.setdefault(y, []).append(f'<Folder><name>{n}</name>{body}</Folder>')
    folders['Drilling 2021'].append(folders['Drilling 2021'][1])          # duplicate folder (same drawings)
    folders['Drilling 2023'].append('<Folder><name>Testjob Empty</name></Folder>')
    kml = ('<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>My Places.kmz</name>'
           '<Style id="s1"><LineStyle><color>ff0000ff</color><width>2</width></LineStyle></Style><Style id="s2"><LineStyle><color>ff00ffff</color><width>2</width></LineStyle></Style>'
           '<Folder><name>My Places</name>' + ''.join(f'<Folder><name>{y}</name>{"".join(fs)}</Folder>' for y, fs in folders.items()) + '</Folder></Document></kml>')
    p = os.path.join(tmp, 'synthetic-jobs.kmz')
    with zipfile.ZipFile(p, 'w', zipfile.ZIP_DEFLATED) as z: z.writestr('doc.kml', kml)
    js = {'app': 'wells-nearby', 'kind': 'my-jobs', 'version': 1, 'jobs': [
        {'key': f'{y}/{n}'.lower(), 'name': n, 'group': y, 'year': int(y[-4:]), 'kind': 'destruction' if 'destr' in n else 'new', 'well': {'lat': la, 'lon': lo, 'src': 'test'}, 'wells': [],
         'pm': [{'n': 'proposed well', 't': 'L', 'c': [[la, lo], [la + 0.00001, lo]]}], 'confidence': 'high' if i == 0 else 'none',
         'match': {'permit': 'DEH2021-LWELL-000001', 'confidence': 'high', 'reason': 'same APN; permit same year', 'apn': '000-000-00-00', 'distM': 12,
                   'docs': [{'url': 'https://file.sandiegocounty.gov/LUEG/LUEG_View?FileRecordId=1', 'label': 'Water Well Permit', 'date': '2021-01-01'}]} if i == 0 else None}
        for i, (y, n, la, lo, wn) in enumerate(J)]}
    pj = os.path.join(tmp, 'synthetic-my-jobs.json'); json.dump(js, open(pj, 'w'))
    return p, pj, 4, [n for _, n, *_ in J]

with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
    if a.file: kmz, jsn, expect, secrets = a.file, a.json, a.expect, []
    else: kmz, jsn, expect, secrets = synthetic(tmp)
    prof = os.path.join(tmp, 'profile')
    ctx = p.chromium.launch_persistent_context(prof, executable_path='/usr/bin/google-chrome', args=['--no-sandbox'], viewport={'width': 390, 'height': 844},
        is_mobile=True, has_touch=True, device_scale_factor=2)
    pg = ctx.new_page(); errs, reqs = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)[:300]))
    pg.on('request', lambda r: reqs.append((r.method, r.url, r.post_data or '')))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(f'{base}index.html?lat=33.0417&lon=-116.8681&r=0.25')
    pg.wait_for_function('window.WellsMyJobs && window.WellsApp', timeout=60000)
    check(pg.locator('.myjobs-ctl .mj-btn').count() == 1, 'My jobs control on the map')
    pg.click('.myjobs-ctl .mj-btn')
    check(pg.locator('.myjobs-ctl .mj-file').count() == 1 and 'nothing is uploaded' in pg.inner_text('.myjobs-ctl .mj-panel'), 'import control + privacy note shown before import')
    pg.set_input_files('.myjobs-ctl .mj-file', kmz)
    pg.wait_for_function('() => WellsMyJobs.data && WellsMyJobs.data.jobs.length', timeout=60000); pg.wait_for_timeout(800)
    c = pg.evaluate('WellsMyJobs.counts()')
    print('counts after .kmz import:', c)
    if expect: check(c['jobs'] == expect, f'jobs count {c["jobs"]} == expected {expect}')
    check(c['jobs'] > 0 and c['lines'] > 0, f'{c["jobs"]} jobs, {c["lines"]} drawings imported')
    check(pg.evaluate('map => 1', None) == 1 and pg.evaluate('WellsApp.map.hasLayer(WellsMyJobs.group)'), 'My Jobs layer is on the map')
    nIcons = pg.locator('.mj-pin, .mj-cluster').count()
    check(nIcons > 0, f'job pins / clusters drawn ({nIcons} at zoom {pg.evaluate("WellsApp.map.getZoom()")})')
    check('My Jobs' in pg.inner_text('.leaflet-control-layers-overlays'), 'listed in the layer control')
    # zoom to one job -> drawings
    pg.evaluate('() => WellsMyJobs.zoomJob(WellsMyJobs.visibleJobs()[0])'); pg.wait_for_timeout(1200)
    nDraw = pg.evaluate("() => { let n = 0; WellsMyJobs.group.eachLayer(g => g.eachLayer && g.eachLayer(l => { if (l instanceof L.Path && !(l instanceof L.CircleMarker)) n++; })); return n; }")
    check(nDraw > 0, f'job drawings drawn when zoomed in ({nDraw} paths)')
    pg.locator('.mj-pin').first.click(); pg.wait_for_selector('.leaflet-popup .mj-popup', timeout=10000)
    ptxt = pg.inner_text('.leaflet-popup .mj-popup')
    check('My job' in ptxt and 'Well point' in ptxt and re.search(r'Drilling \d{4}|\w', ptxt) is not None, 'job popup: name, year folder, well point')
    if a.shots: pg.screenshot(path=os.path.join(a.shots, 'myjobs-popup.png'))
    pg.evaluate('WellsApp.map.closePopup()')
    # persists after reload
    pg.reload(); pg.wait_for_function('window.WellsMyJobs', timeout=60000); pg.wait_for_timeout(1500)
    c2 = pg.evaluate('WellsMyJobs.data ? WellsMyJobs.counts() : null')
    check(c2 == c and pg.evaluate('WellsApp.map.hasLayer(WellsMyJobs.group)'), f'persists after reload ({c2 and c2["jobs"]} jobs, layer on)')
    # matched .json
    if jsn:
        pg.click('.myjobs-ctl .mj-btn') if 'open' not in (pg.get_attribute('.myjobs-ctl', 'class') or '') else None
        pg.set_input_files('.myjobs-ctl .mj-file', jsn)
        pg.wait_for_function('() => WellsMyJobs.data && WellsMyJobs.data.hasMatches', timeout=60000); pg.wait_for_timeout(800)
        cj = pg.evaluate('WellsMyJobs.counts()'); print('counts after .json import:', cj)
        if expect: check(cj['jobs'] == expect, f'.json import: {cj["jobs"]} jobs')
        conf = pg.evaluate("() => { const o = {}; for (const j of WellsMyJobs.visibleJobs()) { const k = j.confidence || 'none'; o[k] = (o[k] || 0) + 1; } return o; }")
        print('confidence:', conf)
        jm = pg.evaluate("() => { const j = WellsMyJobs.visibleJobs().find(x => x.match); return j ? WellsMyJobs.visibleJobs().indexOf(j) : -1; }")
        check(jm >= 0, 'matched jobs present after .json import')
        if jm >= 0:
            pg.evaluate(f'() => {{ const j = WellsMyJobs.visibleJobs()[{jm}]; WellsApp.map.setView([j.well.lat, j.well.lon], 17); }}'); pg.wait_for_timeout(1200)
            pg.evaluate(f"""() => {{ const j = WellsMyJobs.visibleJobs()[{jm}]; let m = null; WellsMyJobs.group.eachLayer(g => g.eachLayer && g.eachLayer(l => {{ if (l.getLatLng && l.options.title === j.name && Math.abs(l.getLatLng().lat - j.well.lat) < 1e-9) m = l; }})); m && m.openPopup(); }}""")
            pg.wait_for_selector('.leaflet-popup .mj-conf', timeout=10000); pg.wait_for_timeout(1500)
            check(pg.locator('.leaflet-popup .mj-conf').count() == 1, 'job popup stays open after the map auto-pans')
            t = pg.inner_text('.leaflet-popup .mj-popup')
            links = pg.evaluate("() => [...document.querySelectorAll('.leaflet-popup .mj-popup a')].map(a => a.href)")
            check('permit' in t and any('LUEG_View' in h for h in links), f'popup shows matched permit + County document link ({len(links)} links)')
            if a.shots: pg.screenshot(path=os.path.join(a.shots, 'myjobs-match-popup.png'))
            pg.evaluate('WellsApp.map.closePopup()')
    # APN search still works
    pg.evaluate("() => { WellsApp.state.lat = 0; WellsApp.state.lon = 0; }")
    inp = pg.locator('.as-input'); inp.fill('285-030-06-00'); inp.press('Enter')
    try: pg.wait_for_function('() => WellsApp.state.lat !== 0', timeout=30000)
    except Exception: pass
    st = pg.evaluate('({lat: WellsApp.state.lat, lon: WellsApp.state.lon, how: WellsApp.state.how})')
    check(st['lat'] != 0 and 'APN 285-030-06-00' in (st['how'] or '').upper(), f'APN search 285-030-06-00 still works -> {st}')
    try: pg.wait_for_selector('#summary:not(.hidden)', timeout=60000); check(True, 'well search after APN search renders the summary')
    except Exception: check(False, 'well search after APN search renders the summary')
    # privacy: no request carries job names / the file
    names = secrets or pg.evaluate('() => WellsMyJobs.data.jobs.map(j => j.name).filter(n => n.length >= 6)')
    leak = [u for (m, u, body) in reqs for n in names if n and (n.lower() in u.lower() or n.lower() in body.lower() or n.replace(' ', '%20').lower() in u.lower() or n.replace(' ', '+').lower() in u.lower())]
    posts = [u for (m, u, body) in reqs if m not in ('GET', 'HEAD', 'OPTIONS')]
    check(not leak, f'no job name in any of {len(reqs)} requests {leak[:2]}')
    check(not posts, f'no POST/PUT uploads {posts[:2]}')
    # remove
    if 'open' not in (pg.get_attribute('.myjobs-ctl', 'class') or ''): pg.click('.myjobs-ctl .mj-btn')
    pg.click('.myjobs-ctl .mj-del'); pg.wait_for_timeout(800)
    check(pg.evaluate('WellsMyJobs.data') is None and pg.locator('.mj-pin, .mj-cluster').count() == 0, 'Remove my jobs: data + pins gone')
    pg.reload(); pg.wait_for_function('window.WellsMyJobs', timeout=60000); pg.wait_for_timeout(1500)
    left = pg.evaluate("() => new Promise(r => { const q = indexedDB.open('wells-nearby-myjobs'); q.onsuccess = () => { const t = q.result.transaction('data').objectStore('data').count(); t.onsuccess = () => r(t.result); }; q.onerror = () => r(-1); })")
    check(left == 0 and pg.evaluate('WellsMyJobs.data') is None, f'still removed after reload (IndexedDB records: {left})')
    check(not errs, f'0 page errors {errs[:3]}')
    ctx.close()
print(f"\n{'ALL PASSED' if not fails else 'FAILED: ' + '; '.join(fails)}")
raise SystemExit(1 if fails else 0)
