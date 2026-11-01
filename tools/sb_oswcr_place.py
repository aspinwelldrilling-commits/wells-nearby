#!/usr/bin/env python3
"""Tighten San Bernardino OSWCR placements (feeds tools/build_sb_oswcr.py). Network results cached on disk (idempotent).

- APN -> parcel centre: San Bernardino County public parcel layer (ArcGIS Online, ParcelNumber 'BBBBPPPPP'),
  batched 80 APNs/query, 1.2 s apart, retries. Cache: <state>/apn9_cache.json (9-digit APN -> {lat,lon,ac} or null).
- TRS -> PLSS section polygon: BLM CadNSDI (CA27 = San Bernardino Meridian, CA21 = Mount Diablo). Cache: <state>/sec_cache.json.
  Used (a) to place records with no coordinates at their section centre (still section-level / approximate) and
  (b) to verify an APN parcel centre lies in (or within 500 ft of) the report's stated section before upgrading.
No customer data leaves the box: only APNs and T/R/S numbers are sent to the public map services.
"""
import json, os, re, sys, time, urllib.parse, urllib.request, math

STATE = os.environ.get('SB_OSWCR_PLACE_DIR', '/workspace/wells-state/sb-oswcr/place')
PARCELS = ('https://services.arcgis.com/aA3snZwJfFkVyDuP/arcgis/rest/services/Parcels_for_San_Bernardino_County/'
           'FeatureServer/0/query')   # County's public parcel layer (ParcelNumber = 9-digit APN)
PLSS = 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/2/query'
UA = 'WellsNearby-SB-OSWCR/1.1 (aspinwelldrilling-commits; static map build)'
MAX_AC = 40.0          # parcel larger than a quarter-quarter section -> not "exact", keep section-level
EDGE_DEG = 0.0015      # ~500 ft tolerance outside the stated section


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def post(url, params):
    for i in range(5):
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode(), headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                j = json.loads(r.read().decode())
            if 'error' in j:
                raise RuntimeError(j['error'])
            time.sleep(1.2)
            return j
        except Exception as e:
            log('retry', i + 1, e); time.sleep(5 * (i + 1))
    return None


def area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def centroid(ring):
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


def dist_deg(lat, lon, rings):   # distance (deg, lon scaled) from point to polygon edge; 0 if inside
    if in_rings(lat, lon, rings):
        return 0.0
    k = math.cos(math.radians(lat)); best = 9e9
    for ring in rings:
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            ax, ay, bx, by, px, py = x1 * k, y1, x2 * k, y2, lon * k, lat
            dx, dy = bx - ax, by - ay
            t = 0 if dx == dy == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
            best = min(best, math.hypot(px - ax - t * dx, py - ay - t * dy))
    return best


def norm_apn(raw):
    """SB APN -> 'BBBB-PPP-PP-SSSS' or None. Book is 4 digits (often written with 3)."""
    s = str(raw or '').strip()
    if not s or re.search(r'[A-Za-z]', s.replace('APN', '')):
        return None
    parts = [p for p in re.split(r'[^0-9]+', s) if p]
    if len(parts) >= 3 and all(len(p) <= 4 for p in parts[:3]) and len(parts[1]) == 3 and len(parts[2]) in (1, 2) and len(parts[0]) in (3, 4):
        suf = parts[3] if len(parts) > 3 and len(parts[3]) <= 4 else '0'
        return f'{parts[0].zfill(4)}-{parts[1]}-{parts[2].zfill(2)}-{suf.zfill(4)}'
    d = ''.join(parts)
    if len(parts) > 1 and len(parts) < 3:
        return None
    if len(d) == 8:
        d = '0' + d
    if len(d) in (9, 13):
        d = d.ljust(13, '0')
        return f'{d[:4]}-{d[4:7]}-{d[7:9]}-{d[9:13]}'
    return None


def apn9(raw):
    n = norm_apn(raw)
    return n.replace('-', '')[:9] if n else None


def sec_fid(t, r, s, mer):
    m1, m2 = re.fullmatch(r'0*(\d{1,3})([NS])', (t or '').strip().upper()), re.fullmatch(r'0*(\d{1,3})([EW])', (r or '').strip().upper())
    try:
        sec = int(str(s).strip())
    except (TypeError, ValueError):
        return None
    mer = (mer or '').upper()
    pre = 'CA27' if 'BERNARDINO' in mer else 'CA21' if 'DIABLO' in mer else None
    if not (m1 and m2 and pre and 1 <= sec <= 36):
        return None
    return '%s%03d0%s%03d0%s0SN%02d0' % (pre, int(m1.group(1)), m1.group(2), int(m2.group(1)), m2.group(2), sec)


def load(name):
    p = os.path.join(STATE, name)
    return json.load(open(p)) if os.path.exists(p) else {}


def save(name, obj):
    os.makedirs(STATE, exist_ok=True)
    tmp = os.path.join(STATE, name + '.tmp'); json.dump(obj, open(tmp, 'w')); os.replace(tmp, os.path.join(STATE, name))


def fetch_sections(fids):
    cache = load('sec_cache.json'); todo = sorted(set(f for f in fids if f and f not in cache))
    log('sections to fetch', len(todo))
    for i in range(0, len(todo), 40):
        chunk = todo[i:i + 40]
        j = post(PLSS, {'where': 'FRSTDIVID IN (%s)' % ','.join("'%s'" % f for f in chunk), 'outFields': 'FRSTDIVID',
                        'returnGeometry': 'true', 'outSR': '4326', 'maxAllowableOffset': '0.00005', 'f': 'json'})
        if j is None:
            continue   # not cached -> retried next run
        got = {}
        for f in j.get('features') or []:
            got.setdefault(f['attributes']['FRSTDIVID'], []).extend(f['geometry']['rings'])
        for f in chunk:
            rings = got.get(f)
            if rings:
                big = max(rings, key=area); lat, lon = centroid(big)
                cache[f] = {'lat': round(lat, 6), 'lon': round(lon, 6), 'rings': [[[round(x, 5), round(y, 5)] for x, y in r] for r in rings]}
            else:
                cache[f] = None
        save('sec_cache.json', cache); log('sections', i + len(chunk), '/', len(todo))
    return cache


def fetch_apns(apns):
    cache = load('apn9_cache.json'); todo = sorted(set(a for a in apns if a and a not in cache))
    log('APNs to fetch', len(todo))
    for i in range(0, len(todo), 80):
        chunk = todo[i:i + 80]
        j = post(PARCELS, {'where': "ParcelNumber IN (%s)" % ','.join("'%s'" % a for a in chunk),
                           'outFields': 'ParcelNumber', 'returnGeometry': 'true', 'outSR': '4326', 'f': 'json'})
        if j is None:
            continue
        got = {}
        for f in j.get('features') or []:
            if f.get('geometry'):
                got.setdefault(f['attributes']['ParcelNumber'], []).extend(f['geometry']['rings'])
        for a in chunk:
            rings = got.get(a)
            if not rings:
                cache[a] = None; continue
            big = max(rings, key=area); lat, lon = centroid(big)
            if not in_rings(lat, lon, rings):
                xs, ys = [p[0] for p in big], [p[1] for p in big]
                lat, lon = (min(ys) + max(ys)) / 2, (min(xs) + max(xs)) / 2
                if not in_rings(lat, lon, rings):
                    lat, lon = big[0][1], big[0][0]
            ac = sum(area(r) for r in rings) * (69.05 * 5280) * (69.05 * 5280 * math.cos(math.radians(lat))) / 43560
            cache[a] = {'lat': round(lat, 6), 'lon': round(lon, 6), 'ac': round(ac, 1)}
        if i % 800 == 0:
            save('apn9_cache.json', cache)
        log('apns', i + len(chunk), '/', len(todo))
    save('apn9_cache.json', cache)
    return cache


if __name__ == '__main__':
    recs = json.load(open(sys.argv[1]))
    fetch_sections([sec_fid(a.get('Township'), a.get('Range'), a.get('Section'), a.get('BaselineMeridian')) for a in recs])
    fetch_apns([apn9(a.get('APN')) for a in recs])
