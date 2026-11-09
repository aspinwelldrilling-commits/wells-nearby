#!/usr/bin/env python3
"""San Bernardino County weekly well permits (Environmental Health weekly PDF) -> data/sbcounty-permits/.

Safe to run any number of times (weekly routine, Mondays):
  python3 tools/sb_weekly_permits.py            # download, archive, parse, geocode new permits, write permits.json
  python3 tools/sb_weekly_permits.py --push     # ...then git pull --rebase, commit ONLY data/sbcounty-permits, push
  python3 tools/sb_weekly_permits.py --pdf FILE # parse a saved PDF instead of downloading (backfill)

The county page only shows the latest week, so every distinct PDF is kept as archive/<week-end YYYY-MM-DD>.pdf
(same week re-downloaded with identical bytes = no-op; changed bytes for the same week = <date>-<sha8>.pdf).
Permits are keyed by PERMIT_NO (de-duped; a re-issued row updates the record, first-seen week kept).
Placement: parcel centre by APN from DWR's statewide assessor-parcel layer (LightBox, COUNTYNAME='San Bernardino',
TAXAPN 'XXXX-XXX-XX-XXXX'), point-in-polygon checked (`pl:'apn'`). If the APN is not found / not a plain APN
("ADJ TO ..."), the centre of the PLSS section from the PDF's TWN/RNG/SEC (San Bernardino Meridian, BLM CadNSDI)
is used and flagged approximate (`pl:'section'`). Placements are cached in permits.json; only new/unplaced permits
are looked up. No customer data: the PDF holds APN, TRS, city, well type and contractor only.
"""
import argparse, datetime as dt, hashlib, json, os, re, subprocess, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'sbcounty-permits')
ARCH = os.path.join(OUT, 'archive')
PDF_URL = 'https://ehs.sbcounty.gov/wp-content/uploads/sites/97/Programs/WaterAndWaste/weekly-well-report.pdf'
PARCELS = 'https://gis.water.ca.gov/arcgis/rest/services/Planning/i15_Parcels_Assessor_Lightbox/MapServer/0/query'
PLSS = 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/2/query'
UA = 'WellsNearby-SB-permits/1.0 (aspinwelldrilling-commits; static map build)'
SB_BOX = (33.80, -117.85, 35.85, -114.10)
WATER = re.compile(r'domestic|community|irrigation|agricult|industrial|municipal|public|stock|test well|supply', re.I)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def post(url, params):
    for i in range(4):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode(), headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                j = json.loads(r.read().decode())
            if 'error' in j:
                raise RuntimeError(j['error'])
            time.sleep(1.0)
            return j
        except Exception as e:
            log('retry', i + 1, e); time.sleep(4 * (i + 1))
    return None


def parse(pdf):
    txt = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True, check=True).stdout
    m = re.search(r'(\w+day), (\w+ \d+, \d{4}) - (\w+day), (\w+ \d+, \d{4})', txt)
    if not m:
        raise SystemExit('week dates not found in PDF (format changed?)')
    d = lambda s: dt.datetime.strptime(s, '%B %d, %Y').date().isoformat()
    start, end = d(m.group(2)), d(m.group(4))
    lines = txt.splitlines()
    rows, i = [], 0
    row_re = re.compile(r'^\s*(\d{1,2}/\d{1,2}/\d{4})\s+(\d{6,})\s+(WP\d+)\s+(\d+[NS])\s+(\d+[EW])\s+(\d+)\s+(.*)$')
    while i < len(lines):
        mm = row_re.match(lines[i])
        if not mm:
            i += 1; continue
        rest = re.split(r'\s{2,}', mm.group(7).strip())
        j = i + 1
        while len(rest) < 5 and j < len(lines) and lines[j].strip() and not row_re.match(lines[j]):
            rest += re.split(r'\s{2,}', lines[j].strip()); j += 1
        i = j
        city, apn_txt, desc, work, contractor = (rest + [''] * 5)[:5]
        if len(rest) > 5:
            contractor = ' '.join(rest[4:])
        digits = re.search(r'\d{13}|\d{12}|\d{9,10}', apn_txt.replace('-', ''))
        mo, da, yr = mm.group(1).split('/')
        rows.append({'pn': mm.group(2), 'rid': mm.group(3), 'ent': f'{yr}-{int(mo):02d}-{int(da):02d}',
                     'twn': mm.group(4), 'rng': mm.group(5), 'sec': int(mm.group(6)), 'city': city.strip(),
                     'apnRaw': apn_txt.strip(), 'apn': digits.group(0).ljust(13, '0') if digits else None,
                     'desc': desc.replace('\\ ', ' / ').replace('\\', '/').strip(), 'work': work.strip(), 'ctr': contractor.strip()})
    return start, end, rows


def kind(p):
    if re.search(r'destr', p['work'], re.I):
        return 'd'
    return 'w' if WATER.search(p['desc']) else 'm'


def ring_centroid(ring):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        f = x1 * y2 - x2 * y1; a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f
    if abs(a) < 1e-14:
        return sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring)
    return cy / (3 * a), cx / (3 * a)


def in_rings(lat, lon, rings):
    c = False
    for ring in rings:
        for k in range(len(ring)):
            x1, y1 = ring[k]; x2, y2 = ring[k - 1]
            if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                c = not c
    return c


def area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def by_apn(apn13):
    tax = f'{apn13[:4]}-{apn13[4:7]}-{apn13[7:9]}-{apn13[9:13]}'
    j = post(PARCELS, {'where': f"COUNTYNAME='San Bernardino' AND TAXAPN='{tax}'", 'outFields': 'TAXAPN,SITE_ADDR,SITE_CITY',
                       'returnGeometry': 'true', 'outSR': '4326', 'f': 'json'})
    feats = (j or {}).get('features') or []
    if not feats:
        return None
    rings = [r for f in feats for r in f['geometry']['rings']]
    big = max(rings, key=area)
    lat, lon = ring_centroid(big)
    if not in_rings(lat, lon, rings):   # odd shape: centroid outside -> nearest vertex-average fallback inside bbox
        xs, ys = [p[0] for p in big], [p[1] for p in big]
        lat, lon = (min(ys) + max(ys)) / 2, (min(xs) + max(xs)) / 2
        if not in_rings(lat, lon, rings):
            lat, lon = big[0][1], big[0][0]
    acres = sum(area(r) for r in rings) * (364000 * 300000) / 43560   # rough (ft per deg at ~34.5 N)
    return {'lat': round(lat, 6), 'lon': round(lon, 6), 'pl': 'apn', 'tax': tax, 'ac': round(acres, 1)}


def by_section(p):
    t, r = p['twn'], p['rng']
    fid = 'CA27%03d0%s%03d0%s0SN%02d0' % (int(t[:-1]), t[-1], int(r[:-1]), r[-1], p['sec'])
    j = post(PLSS, {'where': f"FRSTDIVID='{fid}'", 'outFields': 'FRSTDIVID', 'returnGeometry': 'true', 'outSR': '4326',
                    'f': 'json'})
    feats = (j or {}).get('features') or []
    if not feats:
        return None
    big = max((rr for f in feats for rr in f['geometry']['rings']), key=area)
    lat, lon = ring_centroid(big)
    return {'lat': round(lat, 6), 'lon': round(lon, 6), 'pl': 'section', 'trs': f"T{t} R{r} Sec {p['sec']} SBM"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf'); ap.add_argument('--push', action='store_true')
    a = ap.parse_args()
    os.makedirs(ARCH, exist_ok=True)
    if a.pdf:
        data = open(a.pdf, 'rb').read()
    else:
        req = urllib.request.Request(PDF_URL, headers={'User-Agent': 'Mozilla/5.0 ' + UA})
        data = urllib.request.urlopen(req, timeout=60).read()
    if not data.startswith(b'%PDF'):
        raise SystemExit('download is not a PDF; nothing changed')
    tmp = os.path.join('/tmp', 'sb-weekly-%d.pdf' % os.getpid())
    open(tmp, 'wb').write(data)
    start, end, rows = parse(tmp)
    sha = hashlib.sha1(data).hexdigest()
    path = os.path.join(OUT, 'permits.json')
    db = json.load(open(path)) if os.path.exists(path) else {'permits': {}, 'weeks': []}
    week = next((w for w in db['weeks'] if w['sha'] == sha), None)
    if week:
        log('PDF already archived as', week['file'])
    else:
        name = end + '.pdf'
        if os.path.exists(os.path.join(ARCH, name)):
            name = f'{end}-{sha[:8]}.pdf'
        os.replace(tmp, os.path.join(ARCH, name))
        week = {'start': start, 'end': end, 'file': 'archive/' + name, 'sha': sha, 'rows': len(rows),
                'fetched': dt.datetime.now().astimezone().isoformat(timespec='seconds')}
        db['weeks'].append(week)
        log('archived', name, len(rows), 'rows')
    if os.path.exists(tmp):
        os.remove(tmp)
    new = 0
    for p in rows:
        old = db['permits'].get(p['pn'], {})
        rec = {**old, **p, 'k': kind(p), 'week': old.get('week', end)}
        if p['apn'] != old.get('apn') or p['twn'] != old.get('twn') or p['sec'] != old.get('sec'):
            for k in ('lat', 'lon', 'pl', 'tax', 'ac', 'trs'):
                rec.pop(k, None)
        if not rec.get('pl') or rec['pl'] == 'section':   # retry APN for earlier section fallbacks
            g = by_apn(p['apn']) if p['apn'] and re.fullmatch(r'[\d\s-]+', p['apnRaw'].replace(' ', '')) else None
            if g and not (SB_BOX[0] <= g['lat'] <= SB_BOX[2] and SB_BOX[1] <= g['lon'] <= SB_BOX[3]):
                g = None
            g = g or (rec if rec.get('pl') == 'section' else None) or by_section(p)
            if g:
                rec.update({k: g[k] for k in g if k in ('lat', 'lon', 'pl', 'tax', 'ac', 'trs')})
            if p['pn'] not in db['permits']:
                new += 1
        db['permits'][p['pn']] = rec
    ps = db['permits'].values()
    db.update({'version': 1, 'county': 'sanbernardino', 'source': 'San Bernardino County Environmental Health weekly well permit report',
               'sourceUrl': PDF_URL, 'updated': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
               'count': len(db['permits']), 'placedApn': sum(1 for q in ps if q.get('pl') == 'apn'),
               'placedSection': sum(1 for q in ps if q.get('pl') == 'section'),
               'unplaced': sum(1 for q in ps if not q.get('pl')),
               'fields': {'pn': 'PERMIT_NO', 'rid': 'RECORD_ID', 'ent': 'entered', 'k': 'w water / d destruction / m monitoring & other',
                          'pl': "placement: 'apn' parcel centre, 'section' PLSS section centre (approximate)"}})
    db['permits'] = dict(sorted(db['permits'].items()))
    db['weeks'].sort(key=lambda w: w['end'])
    # Skip write/push when nothing meaningful changed (avoids timestamp-only commits on an unchanged PDF).
    prev = json.load(open(path)) if os.path.exists(path) else None
    if prev is not None:
        prev_cmp = {k: v for k, v in prev.items() if k != 'updated'}
        new_cmp = {k: v for k, v in db.items() if k != 'updated'}
        if prev_cmp == new_cmp:
            log('PDF/permits unchanged; skipping write and push')
            log(json.dumps({k: db[k] for k in ('count', 'placedApn', 'placedSection', 'unplaced')}), 'new', new, 'week', start, '-', end)
            return
    with open(path + '.tmp', 'w') as f:
        json.dump(db, f, separators=(',', ':'), sort_keys=True)
    os.replace(path + '.tmp', path)
    log(json.dumps({k: db[k] for k in ('count', 'placedApn', 'placedSection', 'unplaced')}), 'new', new, 'week', start, '-', end)
    if a.push:
        g = lambda *c: subprocess.run(['git', '-C', ROOT, *c], check=True)
        if not subprocess.run(['git', '-C', ROOT, 'status', '--porcelain', 'data/sbcounty-permits'], capture_output=True, text=True).stdout.strip():
            log('no changes to push'); return
        g('add', 'data/sbcounty-permits')
        # Include tools/sb_weekly_permits.py only when this run also fixed the no-op commit guard.
        porcelain = subprocess.run(['git', '-C', ROOT, 'status', '--porcelain', 'tools/sb_weekly_permits.py'],
                                   capture_output=True, text=True).stdout.strip()
        if porcelain:
            g('add', 'tools/sb_weekly_permits.py')
        g('commit', '-m', f'SB County weekly well permits {start}..{end}', '--', 'data/sbcounty-permits',
          *(['tools/sb_weekly_permits.py'] if porcelain else []))
        g('pull', '--rebase'); g('push')


if __name__ == '__main__':
    main()
