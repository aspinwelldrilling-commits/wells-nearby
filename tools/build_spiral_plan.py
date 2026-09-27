#!/usr/bin/env python3
"""Build the county-wide WCR extraction plan: every San Diego County DEH well permit is assigned to the nearest named
area center; areas are grouped in rings spiraling outward from Ramona (Travis's base) and ordered by distance within a ring.

  python3 tools/build_spiral_plan.py            # re-download permit points (one light paged GIS query) and rebuild
  python3 tools/build_spiral_plan.py --cached   # reuse .cache/all-permits.json

Writes tools/spiral_plan.json (areas with permit lists; destruction permits excluded as in extract_county_wcr.py).
Progress is tracked separately by tools/spiral_run.py (tools/spiral_progress.json + tools/spiral_plan.md).
"""
import json, math, os, re, sys, time, urllib.parse, urllib.request, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, '.cache', 'all-permits.json')
PLAN = os.path.join(ROOT, 'tools', 'spiral_plan.json')
LAYER = 'https://gis-public.sandiegocounty.gov/arcgis/rest/services/DPLU/DPLU_Map/MapServer/100/query'
UA = 'WellsNearby-extractor/1.0 (small-business field tool; low-rate)'
RAMONA = (33.0417, -116.8681)

# (id, name, ring, lat, lon).  Ring 0 = already started areas (Ramona / Valley Center 1-mile cores are cached).
AREAS = [
    ('ramona', 'Ramona', 0, 33.0417, -116.8681),
    ('ramona-east', 'Ramona east (Ramona Oaks / Black Canyon)', 1, 33.035, -116.80),
    ('sd-country-estates', 'San Diego Country Estates', 1, 33.000, -116.785),
    ('ramona-north', 'Ramona north (Rangeland / Pamo / Sutherland)', 1, 33.105, -116.850),
    ('highland-valley', 'Highland Valley / Mt Woodson', 1, 33.020, -116.950),
    ('san-pasqual', 'San Pasqual / Escondido east', 1, 33.090, -116.975),
    ('santa-ysabel', 'Santa Ysabel / Witch Creek', 1, 33.095, -116.690),
    ('julian', 'Julian / Wynola / Pine Hills', 1, 33.070, -116.600),
    ('poway', 'Poway', 1, 32.965, -117.020),
    ('lakeside', 'Lakeside / Blossom Valley', 1, 32.870, -116.905),
    ('alpine', 'Alpine / Harbison Canyon', 1, 32.840, -116.770),
    ('valley-center', 'Valley Center', 2, 33.2184, -117.0342),
    ('mesa-grande', 'Mesa Grande / Lake Henshaw', 2, 33.180, -116.760),
    ('escondido', 'Escondido / Hidden Meadows', 2, 33.130, -117.080),
    ('rancho-bernardo', 'Rancho Bernardo / 4S Ranch', 2, 33.010, -117.090),
    ('santee-el-cajon', 'Santee / El Cajon / Crest / Dehesa', 2, 32.810, -116.950),
    ('jamul', 'Jamul', 2, 32.720, -116.870),
    ('descanso', 'Descanso / Guatay', 2, 32.855, -116.610),
    ('cuyamaca', 'Cuyamaca / Harrison Park', 2, 32.970, -116.580),
    ('pauma', 'Pauma Valley / Rincon', 2, 33.300, -116.980),
    ('warner-springs', 'Warner Springs / Sunshine Summit', 2, 33.280, -116.640),
    ('ranchita', 'Ranchita / San Felipe', 2, 33.200, -116.520),
    ('san-marcos', 'San Marcos / Twin Oaks / Harmony Grove', 3, 33.160, -117.170),
    ('rancho-santa-fe', 'Rancho Santa Fe / Elfin Forest / Del Dios', 3, 33.030, -117.180),
    ('pine-valley', 'Pine Valley / Mount Laguna', 3, 32.830, -116.500),
    ('dulzura', 'Dulzura / Otay Lakes', 3, 32.650, -116.780),
    ('palomar', 'Palomar Mountain', 3, 33.330, -116.870),
    ('pala', 'Pala / Pala Mesa', 3, 33.360, -117.080),
    ('bonsall', 'Bonsall / Vista east', 3, 33.280, -117.200),
    ('san-diego', 'San Diego metro / La Mesa / Spring Valley', 3, 32.760, -117.050),
    ('lake-morena', 'Lake Morena / Campo north', 3, 32.690, -116.520),
    ('potrero', 'Potrero / Tecate', 3, 32.610, -116.630),
    ('shelter-valley', 'Shelter Valley / Banner / Earthquake Valley', 3, 33.030, -116.400),
    ('fallbrook', 'Fallbrook', 4, 33.376, -117.251),
    ('rainbow', 'Rainbow', 4, 33.415, -117.150),
    ('oak-grove', 'Oak Grove / Aguanga (county line)', 4, 33.420, -116.800),
    ('vista-oceanside', 'Vista / Oceanside / Carlsbad', 4, 33.200, -117.300),
    ('de-luz', 'De Luz / Camp Pendleton', 4, 33.440, -117.310),
    ('coastal-south', 'Coastal north county (Encinitas / Del Mar)', 4, 33.000, -117.260),
    ('chula-vista-otay', 'Chula Vista / Otay Mesa / Bonita', 4, 32.620, -117.020),
    ('campo', 'Campo', 4, 32.610, -116.470),
    ('boulevard', 'Boulevard / Live Oak Springs', 4, 32.670, -116.300),
    ('jacumba', 'Jacumba Hot Springs', 4, 32.620, -116.190),
    ('borrego', 'Borrego Springs', 4, 33.255, -116.375),
    ('ocotillo-wells', 'Ocotillo Wells / Borrego east / desert', 4, 33.140, -116.150),
]


def hav(a, b, c, d):
    r = math.radians; x = math.sin(r(c - a) / 2) ** 2 + math.cos(r(a)) * math.cos(r(c)) * math.sin(r(d - b) / 2) ** 2
    return 3958.7613 * 2 * math.asin(math.sqrt(x))


def download():
    out, off = [], 0
    while True:
        q = urllib.parse.urlencode({'where': '1=1', 'outFields': 'Record_ID,Type_Work', 'returnGeometry': 'true', 'outSR': 4326,
                                    'orderByFields': 'OBJECTID', 'resultOffset': off, 'resultRecordCount': 2000, 'f': 'json'})
        j = json.load(urllib.request.urlopen(urllib.request.Request(LAYER + '?' + q, headers={'User-Agent': UA}), timeout=120))
        f = j.get('features', [])
        out += [dict(id=x['attributes']['Record_ID'], t=x['attributes']['Type_Work'], lat=(x.get('geometry') or {}).get('y'),
                     lon=(x.get('geometry') or {}).get('x')) for x in f]
        if not f or not j.get('exceededTransferLimit'): break
        off += len(f); time.sleep(1.5)
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump(out, open(CACHE, 'w'))
    return out


def main():
    pts = json.load(open(CACHE)) if '--cached' in sys.argv and os.path.exists(CACHE) else download()
    areas = {a[0]: {'id': a[0], 'name': a[1], 'ring': a[2], 'lat': a[3], 'lon': a[4],
                    'distMi': round(hav(RAMONA[0], RAMONA[1], a[3], a[4]), 1), 'permits': [], 'destruction': 0} for a in AREAS}
    for p in pts:
        if not p.get('id') or p.get('lat') is None: continue
        a = min(AREAS, key=lambda a: hav(p['lat'], p['lon'], a[3], a[4]))[0]
        if re.search(r'destr', p.get('t') or '', re.I): areas[a]['destruction'] += 1
        else: areas[a]['permits'].append(p['id'].upper())
    order = sorted(areas.values(), key=lambda a: (a['ring'], a['distMi']))
    for i, a in enumerate(order, 1):
        a['order'] = i; a['permits'] = sorted(set(a['permits'])); a['count'] = len(a['permits'])
    plan = {'generated': dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'center': {'name': 'Ramona', 'lat': RAMONA[0], 'lon': RAMONA[1]},
            'method': 'each non-destruction county DEH well permit assigned to the nearest area center (Voronoi); rings outward from Ramona',
            'totalPermits': sum(a['count'] for a in order), 'areas': order}
    json.dump(plan, open(PLAN, 'w'), indent=0)
    for a in order: print(f"{a['order']:>2} r{a['ring']} {a['id']:<22} {a['distMi']:>5} mi {a['count']:>5} permits")
    print('total', plan['totalPermits'])


if __name__ == '__main__':
    main()
