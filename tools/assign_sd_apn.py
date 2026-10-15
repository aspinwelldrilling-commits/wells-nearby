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
Then the parcel's situs address (SanGIS SITUS_* attributes, looked up by APN in batches of 100, 1 s apart, cached per
APN in /workspace/wells-state/sd-oswcr/addr) is written as `ad` (one line, e.g. "802 Main St, Ramona CA 92065"). A parcel
with no situs house number (street name only, or blank) gets no `ad`: the app shows "no address on file".
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


ADDR_CACHE = os.environ.get('SD_ADDR_CACHE', '/workspace/wells-state/sd-oswcr/addr')
ADDR_FIELDS = 'APN,SITUS_ADDRESS,SITUS_FRACTION,SITUS_PRE_DIR,SITUS_STREET,SITUS_SUFFIX,SITUS_POST_DIR,SITUS_SUITE,SITUS_COMMUNITY,SITUS_ZIP,SITUS_JURIS'
JURIS = {'CB': 'Carlsbad', 'CV': 'Chula Vista', 'CO': 'Coronado', 'DM': 'Del Mar', 'EC': 'El Cajon', 'EN': 'Encinitas',
         'ES': 'Escondido', 'IB': 'Imperial Beach', 'LG': 'Lemon Grove', 'LM': 'La Mesa', 'NC': 'National City',
         'OC': 'Oceanside', 'PW': 'Poway', 'SD': 'San Diego', 'SM': 'San Marcos', 'SB': 'Solana Beach', 'ST': 'Santee', 'VS': 'Vista'}


def fetch_addrs(apns, refresh):
    os.makedirs(ADDR_CACHE, exist_ok=True)
    out, need = {}, []
    for a in apns:
        p = os.path.join(ADDR_CACHE, a + '.json')
        if os.path.exists(p) and not refresh: out[a] = json.load(open(p))
        else: need.append(a)
    for i in range(0, len(need), 100):
        chunk = need[i:i + 100]
        p = {'where': 'APN IN (%s)' % ','.join("'%s'" % a for a in chunk), 'outFields': ADDR_FIELDS, 'returnGeometry': 'false', 'f': 'json'}
        for t in range(6):
            try:
                req = urllib.request.Request(URL, data=urllib.parse.urlencode(p).encode(), headers={'User-Agent': UA})
                j = json.loads(urllib.request.urlopen(req, timeout=90).read())
                if 'error' in j: raise RuntimeError(j['error'])
                break
            except Exception as e:
                print('retry', t, e, file=sys.stderr); time.sleep(5 * (t + 1))
        else:
            raise SystemExit('address query failed')
        got = {}
        for f in j.get('features') or []:
            at = f['attributes']; got.setdefault(str(at.get('APN')).strip(), at)
        for a in chunk:
            out[a] = got.get(a) or {}
            json.dump(out[a], open(os.path.join(ADDR_CACHE, a + '.json'), 'w'))
        print('addresses', min(i + 100, len(need)), '/', len(need), file=sys.stderr, flush=True)
        time.sleep(1)
    return out


def tc(s):   # MAIN ST -> Main St; 3RD -> 3rd
    return ' '.join(w.capitalize() if w.isalpha() else w.lower() for w in s.split())


def one_line(a):
    # SanGIS situs attributes -> '802 Main St #B, Ramona CA 92065'; None when there is no house number
    g = lambda k: str(a.get(k) or '').strip()
    try: num = int(a.get('SITUS_ADDRESS') or 0)
    except (TypeError, ValueError): num = 0
    street = g('SITUS_STREET')
    if not num or not street:
        return None
    line = ' '.join(x for x in [str(num), g('SITUS_FRACTION'), g('SITUS_PRE_DIR'), tc(street), tc(g('SITUS_SUFFIX')), g('SITUS_POST_DIR')] if x)
    unit = g('SITUS_SUITE')
    if unit: line += ' #' + unit.lstrip('#')
    city = tc(g('SITUS_COMMUNITY')) or JURIS.get(g('SITUS_JURIS'), '')
    z = g('SITUS_ZIP')[:5]
    return line + ', ' + ' '.join(x for x in [city, 'CA', z if z.isdigit() else ''] if x)


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
    apns = set()
    for _, t in tiles:
        for r in t['wcrs'].values():
            if not section_level(r):
                hits = res[(r['lat'], r['lon'])]
                if hits: apns.add(([h for h in hits if h[:3] < '760'] or hits)[0])
    addrs = {k: one_line(v) for k, v in fetch_addrs(sorted(apns), a.refresh).items()}
    st.update({'withAddress': 0, 'noAddress': 0, 'parcels': len(addrs), 'parcelsNoAddress': sum(1 for v in addrs.values() if not v)})
    for f, t in tiles:
        for r in t['wcrs'].values():
            r.pop('pa', None); r.pop('pq', None); r.pop('ad', None); st['processed'] += 1
            if section_level(r):
                r['pq'] = 's'; st['section'] += 1; continue
            hits = res[(r['lat'], r['lon'])]
            if hits:
                base = [h for h in hits if h[:3] < '760'] or hits
                r['pa'] = base[0]
                if addrs.get(r['pa']): r['ad'] = addrs[r['pa']]; st['withAddress'] += 1
                else: st['noAddress'] += 1
                st['apn'] += 1; st['multi'] += len(base) > 1; st['overlayOnly'] += base is hits and hits[0][:3] >= '760'
            else:
                r['pq'] = 'n'; st['noParcel'] += 1
        body = json.dumps(t['wcrs'], sort_keys=True, separators=(',', ':'))
        with open(f, 'w') as o:
            o.write('{"tile":"%s","bounds":%s,"wcrs":%s}' % (t['tile'], json.dumps(t['bounds'], separators=(',', ':')), body))
        m['tiles'][os.path.basename(f)[:-5]]['h'] = hashlib.sha1(body.encode()).hexdigest()[:10]
    m['apn'] = st | {'source': URL.rsplit('/query', 1)[0], 'method': 'server point-in-polygon (point geometry intersects parcel)'}
    m['fields'].update({'ad': 'one-line situs address of the parcel (SanGIS); absent = no address on file', 'pa': 'APN of the SanGIS parcel containing the point',
                        'pq': 'no APN: s = section-level location, n = true point in no parcel'})
    json.dump(m, open(mp, 'w'), separators=(',', ':'))
    print(json.dumps(st))


if __name__ == '__main__':
    main()
