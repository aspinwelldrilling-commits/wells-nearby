#!/usr/bin/env python3
"""PLSS section areas for the section-level SD state WCRs (data/sd-oswcr/tiles records with pq == 's').

DWR places a "Centroid of Section" / "Derived from TRS" well at the centre of its PLSS section, so that point is not a well
location. For each distinct such point this looks up the BLM PLSS section that contains it (BLM National PLSS CadNSDI,
MapServer layer 2 'PLSS Section', keyed by PLSSID = state+meridian+township+range and FRSTDIVNO = section) and writes:
  data/sd-oswcr/sections.json : { FRSTDIVID: { lab: 'T13S R1E Sec 12', mer: 'San Bernardino', rings: [[[lon,lat],...]] } }
  tile record field  sx      : the FRSTDIVID of its section (absent if BLM has no section there, e.g. Spanish land
                               grants / unsurveyed land, which BLM codes as section '00': the app then draws a soft ~section-size circle instead)
Polygons are generalised to ~5 m (maxAllowableOffset) to keep the file small. If the DWR index carries its own
Township/Range/Section (cached by the pull in /workspace/wells-state/sd-oswcr/plss/dwr_trs_sd.json) the record also gets
`trs` (DWR's label) and the build reports how often DWR's TRS agrees with the BLM section.
  python3 tools/build_sd_sections.py [--refresh]
"""
import glob, json, os, re, sys, time, hashlib, argparse, urllib.parse, urllib.request, concurrent.futures as cf
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'sd-oswcr')
STATE = '/workspace/wells-state/sd-oswcr/plss'
URL = 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/2/query'
UA = 'WellsNearby-SD-PLSS/1.0 (aspinwelldrilling-commits; static map build)'
MER = {'27': 'San Bernardino', '15': 'Humboldt', '21': 'Mount Diablo'}


def get(lat, lon, refresh):
    path = os.path.join(STATE, 'q', '%.6f_%.6f.json' % (lat, lon))
    if os.path.exists(path) and not refresh:
        return json.load(open(path))
    p = {'geometry': '%r,%r' % (lon, lat), 'geometryType': 'esriGeometryPoint', 'inSR': 4326, 'outSR': 4326,
         'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'PLSSID,FRSTDIVID,FRSTDIVNO,FRSTDIVTYP,FRSTDIVLAB',
         'returnGeometry': 'true', 'maxAllowableOffset': 0.00005, 'geometryPrecision': 6, 'f': 'json'}
    for i in range(6):
        try:
            req = urllib.request.Request(URL, data=urllib.parse.urlencode(p).encode(), headers={'User-Agent': UA})
            j = json.loads(urllib.request.urlopen(req, timeout=90).read())
            if 'error' in j: raise RuntimeError(j['error'])
            break
        except Exception as e:
            print('retry', i, e, file=sys.stderr); time.sleep(4 * (i + 1))
    else:
        raise SystemExit('BLM query failed')
    feats = [{'a': f['attributes'], 'rings': f['geometry']['rings']} for f in j.get('features') or [] if f.get('geometry')]
    json.dump(feats, open(path, 'w'))
    return feats


def by_id(fid, refresh):   # a section polygon by FRSTDIVID (used when DWR's TRS names a different section of the township)
    path = os.path.join(STATE, 'q', 'id_' + fid + '.json')
    if os.path.exists(path) and not refresh:
        return json.load(open(path))
    p = {'where': "FRSTDIVID='%s'" % fid, 'outSR': 4326, 'outFields': 'PLSSID,FRSTDIVID,FRSTDIVNO,FRSTDIVTYP,FRSTDIVLAB',
         'returnGeometry': 'true', 'maxAllowableOffset': 0.00005, 'geometryPrecision': 6, 'f': 'json'}
    req = urllib.request.Request(URL, data=urllib.parse.urlencode(p).encode(), headers={'User-Agent': UA})
    j = json.loads(urllib.request.urlopen(req, timeout=90).read())
    feats = [{'a': f['attributes'], 'rings': f['geometry']['rings']} for f in j.get('features') or [] if f.get('geometry')]
    json.dump(feats, open(path, 'w'))
    return feats


def label(pid, no):   # CA270130S0010E0 -> T13S R1E Sec 12
    m = re.match(r'^[A-Z]{2}(\d\d)(\d{3})(\d)([NS])(\d{3})(\d)([EW])', pid or '')
    if not m:
        return None, None
    fr = lambda f: {'1': '¼', '2': '½', '3': '¾'}.get(f, '')
    sec = str(int(no)) if (no or '').isdigit() else (no or '?')
    return f'T{int(m[2])}{fr(m[3])}{m[4]} R{int(m[5])}{fr(m[6])}{m[7]} Sec {sec}', MER.get(m[1], 'meridian ' + m[1])


def dwr_label(t):
    tw, rg, sc = (str(t.get(k) or '').strip().upper() for k in ('Township', 'Range', 'Section'))
    if not (tw and rg and sc):
        return None
    tw = re.sub(r'^0*', '', tw); rg = re.sub(r'^0*', '', rg); sc = re.sub(r'^0*', '', sc)
    return f'T{tw} R{rg} Sec {sc}'


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--refresh', action='store_true'); a = ap.parse_args()
    os.makedirs(os.path.join(STATE, 'q'), exist_ok=True)
    dwr = {}
    p = os.path.join(STATE, 'dwr_trs_sd.json')
    if os.path.exists(p):
        dwr = {t['WCRNumber']: t for t in json.load(open(p)) if t.get('WCRNumber')}
    files = sorted(glob.glob(os.path.join(OUT, 'tiles', '*.json')))
    tiles = [(f, json.load(open(f))) for f in files]
    pts = sorted({(r['lat'], r['lon']) for _, t in tiles for r in t['wcrs'].values() if r.get('pq') == 's'})
    print('section-level points', len(pts), file=sys.stderr, flush=True)
    with cf.ThreadPoolExecutor(5) as ex:
        res = dict(zip(pts, ex.map(lambda q: get(q[0], q[1], a.refresh), pts)))
    secs, st = {}, {'wells': 0, 'withSection': 0, 'noSection': 0, 'multiHit': 0, 'dwrAgree': 0, 'dwrDiffer': 0, 'dwrNone': 0, 'usedDwrSection': 0}
    mp = os.path.join(OUT, 'manifest.json'); m = json.load(open(mp))
    for f, t in tiles:
        for r in t['wcrs'].values():
            r.pop('sx', None); r.pop('trs', None)
            if r.get('pq') != 's':
                continue
            st['wells'] += 1
            d = dwr_label(dwr.get(r['wcr'], {}))
            if d: r['trs'] = d
            hits = [h for h in res[(r['lat'], r['lon'])] if h['a'].get('FRSTDIVID') and (h['a'].get('FRSTDIVNO') or '0').strip('0')]   # 'SN00' = unsectioned remainder (land grant etc.), not a section
            st['multiHit'] += len(hits) > 1
            if not hits:
                st['noSection'] += 1; continue
            # several hits = point on a section line; prefer the one DWR's TRS names
            h = next((h for h in hits if d and label(h['a']['PLSSID'], h['a']['FRSTDIVNO'])[0] == d), hits[0])
            if d and label(h['a']['PLSSID'], h['a']['FRSTDIVNO'])[0] != d:
                # DWR names another section: use that section's polygon if it is in the same township (the record's TRS
                # is what the driller reported; the point is only DWR's computed centre)
                sn = (dwr.get(r['wcr'], {}).get('Section') or '').strip().lstrip('0')
                tw = label(h['a']['PLSSID'], '1')[0].rsplit(' Sec', 1)[0]
                if sn.isdigit() and d.startswith(tw + ' '):
                    alt = by_id('%sSN%02d0' % (h['a']['PLSSID'], int(sn)), a.refresh)
                    if alt: h = alt[0]; st['usedDwrSection'] += 1
            sid = h['a']['FRSTDIVID']; lab, mer = label(h['a']['PLSSID'], h['a']['FRSTDIVNO'])
            secs.setdefault(sid, {'lab': lab or h['a'].get('FRSTDIVLAB') or sid, 'mer': mer, 'rings': h['rings']})
            r['sx'] = sid; st['withSection'] += 1
            if not d: st['dwrNone'] += 1
            elif d == lab: st['dwrAgree'] += 1
            else: st['dwrDiffer'] += 1
        body = json.dumps(t['wcrs'], sort_keys=True, separators=(',', ':'))
        with open(f, 'w') as o:
            o.write('{"tile":"%s","bounds":%s,"wcrs":%s}' % (t['tile'], json.dumps(t['bounds'], separators=(',', ':')), body))
        m['tiles'][os.path.basename(f)[:-5]]['h'] = hashlib.sha1(body.encode()).hexdigest()[:10]
    sbody = json.dumps(dict(sorted(secs.items())), separators=(',', ':'))
    open(os.path.join(OUT, 'sections.json'), 'w').write(sbody)
    st['sections'] = len(secs)
    m['sections'] = st | {'url': 'sections.json', 'h': hashlib.sha1(sbody.encode()).hexdigest()[:10],
                          'source': URL.rsplit('/query', 1)[0]}
    m['fields'].update({'sx': 'BLM PLSS section id (FRSTDIVID) for section-level wells; geometry in sections.json',
                        'trs': "DWR's own Township/Range/Section for the report"})
    json.dump(m, open(mp, 'w'), separators=(',', ':'))
    print(json.dumps(st))


if __name__ == '__main__':
    main()
