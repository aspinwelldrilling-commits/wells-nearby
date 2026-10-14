#!/usr/bin/env python3
"""Assign a San Diego County APN to every SD state WCR pin in data/sd-oswcr/tiles by true point-in-polygon.

Parcels: SanGIS / County "Assessor Parcels" (DPLU_Map/MapServer/0, the parcel service js/config.js already uses).
Each true-point well is sent to the server as a point geometry (esriSpatialRelIntersects, inSR 4326): the server returns
the parcel polygon(s) that contain the point. No centroid / nearest-parcel logic. A point exactly on a shared parcel line
can hit two parcels. SanGIS also stacks overlay parcels (assessor books 760-799: possessory-interest / condo-air-space /
mineral style records, sometimes hundreds on one footprint) on top of the base parcel, so a base-parcel APN (book < 760)
is preferred; among several base parcels the lowest APN is kept and counted as 'multi'.
Writes into each tile record:
  pa  = containing parcel APN (10 digits, SanGIS 'APN')
  pq  = 's' section-level location (LLAccuracy 'Centroid of Section' or method 'Derived from TRS'): never given an APN
        'n' true point that falls in no parcel (road, water, outside the parcel fabric)
Answers are cached per point in /workspace/wells-state/sd-oswcr/apn (outside the repo). Re-run after build_sd_oswcr.py.
  python3 tools/assign_sd_apn.py [--refresh]
"""
import glob, json, os, sys, time, hashlib, urllib.parse, urllib.request, argparse, concurrent.futures as cf
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, 'data', 'sd-oswcr', 'tiles')
CACHE = os.environ.get('SD_APN_CACHE', '/workspace/wells-state/sd-oswcr/apn')
URL = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/0/query'
UA = 'WellsNearby-SD-APN/1.0 (aspinwelldrilling-commits; static map build)'


def section_level(r):
    return 'centroid' in (r.get('acc') or '').lower() or 'trs' in (r.get('llm') or '').lower()


def query(lat, lon, refresh):
    path = os.path.join(CACHE, '%.6f_%.6f.json' % (lat, lon))
    if os.path.exists(path) and not refresh:
        return json.load(open(path))
    p = {'geometry': '%r,%r' % (lon, lat), 'geometryType': 'esriGeometryPoint', 'inSR': 4326,
         'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'APN', 'returnGeometry': 'false', 'f': 'json'}
    for i in range(6):
        try:
            req = urllib.request.Request(URL, data=urllib.parse.urlencode(p).encode(), headers={'User-Agent': UA})
            j = json.loads(urllib.request.urlopen(req, timeout=60).read())
            if 'error' in j:
                raise RuntimeError(j['error'])
            break
        except Exception as e:
            print('retry', i, e, file=sys.stderr); time.sleep(4 * (i + 1))
    else:
        raise SystemExit('parcel query failed')
    apns = sorted({str(f['attributes'].get('APN')).strip() for f in j.get('features') or [] if f['attributes'].get('APN')})
    json.dump(apns, open(path, 'w'))
    return apns


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--refresh', action='store_true'); a = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    files = sorted(glob.glob(os.path.join(TILES, '*.json')))
    tiles = [(f, json.load(open(f))) for f in files]
    pts = sorted({(r['lat'], r['lon']) for _, t in tiles for r in t['wcrs'].values() if not section_level(r)})
    print('points to query', len(pts), file=sys.stderr, flush=True)
    res, done = {}, 0
    with cf.ThreadPoolExecutor(6) as ex:
        for q, v in zip(pts, ex.map(lambda q: query(q[0], q[1], a.refresh), pts)):
            res[q] = v; done += 1
            if done % 500 == 0: print('queried', done, file=sys.stderr, flush=True)
    st = {'processed': 0, 'apn': 0, 'section': 0, 'noParcel': 0, 'multi': 0, 'overlayOnly': 0}
    mp = os.path.join(ROOT, 'data', 'sd-oswcr', 'manifest.json'); m = json.load(open(mp))
    for f, t in tiles:
        for r in t['wcrs'].values():
            r.pop('pa', None); r.pop('pq', None); st['processed'] += 1
            if section_level(r):
                r['pq'] = 's'; st['section'] += 1; continue
            hits = res[(r['lat'], r['lon'])]
            if hits:
                base = [h for h in hits if h[:3] < '760'] or hits
                r['pa'] = base[0]; st['apn'] += 1; st['multi'] += len(base) > 1; st['overlayOnly'] += base is hits and hits[0][:3] >= '760'
            else:
                r['pq'] = 'n'; st['noParcel'] += 1
        body = json.dumps(t['wcrs'], sort_keys=True, separators=(',', ':'))
        with open(f, 'w') as o:
            o.write('{"tile":"%s","bounds":%s,"wcrs":%s}' % (t['tile'], json.dumps(t['bounds'], separators=(',', ':')), body))
        m['tiles'][os.path.basename(f)[:-5]]['h'] = hashlib.sha1(body.encode()).hexdigest()[:10]
    m['apn'] = st | {'source': URL.rsplit('/query', 1)[0], 'method': 'server point-in-polygon (point geometry intersects parcel)'}
    m['fields'].update({'pa': 'APN of the SanGIS parcel containing the point',
                        'pq': 'no APN: s = section-level location, n = true point in no parcel'})
    json.dump(m, open(mp, 'w'), separators=(',', ':'))
    print(json.dumps(st))


if __name__ == '__main__':
    main()
