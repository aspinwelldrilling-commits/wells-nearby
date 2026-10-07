/* Wells Nearby — address / APN search box on the map (look up wells somewhere without being there).
 * APN first (Travis's rule: addresses change or do not exist yet when the well is drilled):
 *   "285-030-06-00", "2850300600", "28503006", "285-030-06", "APN 285 030 06 00" -> County parcel layer (DPLU_Map/0, the same
 *   service the app already uses), centred on a point inside the parcel, outline drawn.
 *   9 digits ("064-017-171") -> Riverside Assessor parcels and Imperial parcels (DWR statewide layer), both asked;
 *   12 digits ("020-110-038-001", Imperial tax-bill form) -> Imperial; a 10-digit APN not found in San Diego is retried as an
 *   old-style Imperial one ("049-081-25-01" -> 049-081-025).
 * Imperial County places / ZIPs ("600 E Main St, El Centro", "Brawley", "Ocotillo" = the Imperial town, 92259) go to the
 * statewide California locator + the parcel situs in the DWR parcel layer. "Ocotillo Wells" is the San Diego County one (92004).
 * Anything else is a street address in San Diego County:
 *   - SANDAG regional composite locator (public, keyless, CORS; county addresses + roads only, so it is SD-only by design;
 *     it does not understand city names, so a trailing community name is turned into its ZIP code(s)),
 *   - plus the County parcel layer's situs address (exact parcel + APN) when the input starts with a house number.
 * The chosen spot goes through the app's normal path (WellsApp.setLocation -> nearby search, parcel card), with a pin.
 * Recent searches stay on this device (localStorage). Searches are sent only to the geocoder and the parcel service. */
(function () {
  'use strict';
  const C = window.WELLS_CONFIG, A = window.WellsApp, map = A.map;
  const G = C.addressSearch;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'wellsNearby.recentSearches';

  // ---------------------------------------------------------------- input parsing
  /** APN-looking input -> SD 10/8-digit or Riverside 9-digit (dashed/undashed), else null. */
  function parseApn(raw) {
    const s = String(raw || '').trim().replace(/^apn\s*[:#]?\s*/i, '');
    if (!/^[\d\s.\-/]+$/.test(s)) return null;
    const d = s.replace(/\D/g, '');
    if (d.length === 10) return { digits: d, apn: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`, county: 'sd' };
    if (d.length === 9) return { digits: d, apn9: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}`, county: 'riverside' };
    if (d.length === 8) return { digits: d, apn8: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}`, county: 'sd' };
    if (d.length === 12) return { digits: d, apn12: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}-${d.slice(9)}`, county: 'imperial' };
    return /^apn/i.test(String(raw).trim()) || d.length === 11 ? { bad: d.length } : null;
  }
  const fmtApn = (a) => {
    const d = String(a || '').replace(/\D/g, '');
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
    if (d.length === 9) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}`;
    if (d.length === 12) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}-${d.slice(9)}`;
    return String(a || '');
  };

  // Postal communities / places of San Diego County -> ZIP codes (config). Aliases map other spellings to a name.
  const IMP = G.imperialPlaces || {};
  const COMM = Object.assign({}, G.communities), ALIAS = G.communityAliases || {};
  for (const [n, p] of Object.entries(IMP)) if (!COMM[n]) COMM[n] = p.zips;
  const IMP_ZIPS = new Set(Object.values(IMP).flatMap((p) => p.zips));
  const commNames = Object.keys(COMM).concat(Object.keys(ALIAS)).sort((a, b) => b.length - a.length);
  const SUFFIX = new Set(['ST', 'STREET', 'RD', 'ROAD', 'AVE', 'AV', 'AVENUE', 'DR', 'DRIVE', 'LN', 'LANE', 'WAY', 'WY', 'CT', 'COURT', 'PL', 'PLACE', 'BLVD', 'BOULEVARD',
    'TRL', 'TRAIL', 'CIR', 'CIRCLE', 'TER', 'TERRACE', 'PKWY', 'PARKWAY', 'HWY', 'HIGHWAY', 'GLN', 'GLEN', 'LOOP', 'PT', 'POINT', 'RW', 'ROW', 'SQ', 'PATH', 'XING', 'RUN', 'VIS', 'VISTA', 'CV', 'COVE', 'HTS', 'MDW', 'CYN', 'GRN', 'WALK', 'PASS', 'ESTS', 'RDG', 'RIDGE', 'TRCE', 'TRACE']);
  const DIRS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'NE', 'NW', 'SE', 'SW']);
  /** "1521 Main St, Ramona, CA 92065" -> { street: '1521 MAIN ST', community: 'RAMONA', zip: '92065', zips: ['92065'] }.
   *  A trailing place name is taken as the community only after a comma, after a street suffix / number ("Main St Ramona",
   *  "Hwy 78 Ramona"), or on its own ("Ramona") — so "Buena Vista" or "Ramona St" stay street names. */
  function parseAddress(raw) {
    let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9#&'\-/., ]/g, ' ').replace(/\s+/g, ' ').trim();
    let zip = null;
    const zm = s.match(/(?:^|[\s,])(9[12]\d{3})(?:-\d{4})?\s*,?\s*$/);
    if (zm) { zip = zm[1]; s = s.slice(0, zm.index); }
    s = s.replace(/[\s,]+(USA|US|UNITED STATES)[\s,.]*$/, '').replace(/[\s,]+(CA|CALIF|CALIFORNIA)[\s,.]*$/, '').replace(/[\s,.]+$/, '');
    let countyHint = null;
    const cm = s.match(/(^|[\s,]+)IMPERIAL (COUNTY|CO\.?)$/);
    if (cm) { countyHint = 'imperial'; s = s.slice(0, cm.index).replace(/[\s,.]+$/, ''); }
    let community = null;
    for (const n of commNames) {
      if (s !== n && !s.endsWith(' ' + n) && !s.endsWith(',' + n)) continue;
      const rest = s.slice(0, s.length - n.length);
      const restT = rest.replace(/[\s,]+$/, ''), last = restT.split(/[\s,]+/).pop() || '';
      if (restT && !/,\s*$/.test(rest) && !SUFFIX.has(last) && !/^\d+$/.test(last)) continue;
      community = ALIAS[n] || n; s = restT; break;
    }
    const street = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const zips = zip ? [zip] : community ? (COMM[community] || []) : [];
    // Imperial County: an Imperial place name, an Imperial ZIP, or "..., Imperial County"
    const imperial = !!(IMP[community] || (zip && IMP_ZIPS.has(zip)) || countyHint === 'imperial');
    return { street, community, zip, zips, imperial };
  }

  // ---------------------------------------------------------------- network
  async function getJson(url, params, ms) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms || G.timeoutMs);
    try {
      const r = await fetch(url + '?' + new URLSearchParams(params), { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'server error');
      return j;
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'timed out' : (e.message || String(e))); }
    finally { clearTimeout(t); }
  }
  const sqlStr = (v) => String(v).replace(/'/g, "''");
  const PARCEL_FIELDS = 'APN,SITUS_ADDRESS,SITUS_FRACTION,SITUS_PRE_DIR,SITUS_STREET,SITUS_SUFFIX,SITUS_POST_DIR,SITUS_COMMUNITY,SITUS_ZIP,ACREAGE';
  function situs(a) {
    if (!a.SITUS_STREET || !String(a.SITUS_STREET).trim()) return '';
    const num = a.SITUS_ADDRESS ? a.SITUS_ADDRESS + (a.SITUS_FRACTION ? ' ' + a.SITUS_FRACTION : '') : '';
    const st = [num, a.SITUS_PRE_DIR, a.SITUS_STREET, a.SITUS_SUFFIX, a.SITUS_POST_DIR].filter((x) => x && String(x).trim()).join(' ');
    return [st, [a.SITUS_COMMUNITY, (a.SITUS_ZIP || '').slice(0, 5)].filter((x) => x && String(x).trim()).join(' ')].filter(Boolean).join(', ');
  }
  /** Parcel features -> one candidate per APN (a parcel can be several polygons with the same APN). */
  function parcelCands(features, src) {
    const by = new Map();
    for (const f of features || []) {
      const a = f.attributes || {}; const apn = fmtApn(a.APN);
      const rings = f.geometry && f.geometry.rings ? f.geometry.rings.map((r) => r.map(([x, y]) => [y, x])) : [];
      if (!by.has(apn)) by.set(apn, { kind: 'parcel', src, apn, attrs: a, rings: [] });
      by.get(apn).rings.push(...rings);
    }
    return [...by.values()].filter((c) => c.rings.length).map((c) => {
      const [lat, lon] = A.insidePoint(c.rings, c.rings[0][0][0], c.rings[0][0][1]);
      const addr = situs(c.attrs);
      return { kind: 'parcel', src: c.src, apn: c.apn, lat, lon, rings: c.rings, acreage: c.attrs.ACREAGE || null, address: addr,
        community: (c.attrs.SITUS_COMMUNITY || '').trim(), label: src === 'apn' ? `APN ${c.apn}` : (addr || `APN ${c.apn}`),
        sub: src === 'apn' ? [addr || (c.attrs.SITUS_COMMUNITY || '').trim() || 'no street address yet', c.attrs.ACREAGE ? c.attrs.ACREAGE + ' ac' : ''].filter(Boolean).join(' · ')
          : `parcel APN ${c.apn}${c.attrs.ACREAGE ? ' · ' + c.attrs.ACREAGE + ' ac' : ''}` };
    });
  }
  async function findRivApn(p) {
    const RP = C.riversideParcels;
    if (!RP) return [];
    const j = await getJson(RP.url, { where: `APN='${p.digits}'`, outFields: RP.outFields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' });
    return rivParcelCands(j.features, 'apn');
  }
  /** Imperial parcel by APN: 9 digits (XXX-XXX-XXX), or 12 (tax-bill XXX-XXX-XXX-XXX; the layer keys on the first 9). */
  async function findImpApn(d) {
    const IP = C.imperialParcels;
    if (!IP || !/^\d{9}(\d{3})?$/.test(d)) return [];
    const k9 = `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}`;
    const conds = [`PARCEL_APN='${k9}'`];
    if (d.length === 12) conds.push(`TAXAPN='${k9}-${d.slice(9)}'`);
    const j = await getJson(IP.url, { where: `${IP.where} AND (${conds.join(' OR ')})`, outFields: IP.outFields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' });
    return impParcelCands(j.features, 'apn');
  }
  async function findApn(p) {
    const byApn = (a, b) => a.apn.localeCompare(b.apn);
    if (p.apn9 || p.county === 'riverside') {
      // 9 digits: Riverside and Imperial both use XXX-XXX-XXX (Imperial books are 001-07x, Riverside's 1xx-9xx), so ask both
      const r = await Promise.allSettled([findRivApn(p), findImpApn(p.digits)]);
      if (r.every((x) => x.status === 'rejected')) throw r[0].reason;
      return r.flatMap((x) => (x.status === 'fulfilled' ? x.value : [])).sort(byApn);
    }
    if (p.apn12 || p.county === 'imperial') return (await findImpApn(p.digits)).sort(byApn);
    const where = p.apn ? `APN='${p.digits}'` : `APN_8='${p.digits}'`;
    const j = await getJson(C.parcels.url, { where, outFields: PARCEL_FIELDS, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' });
    const cs = parcelCands(j.features, 'apn').sort(byApn);
    // not in San Diego: some old Imperial state records write the APN as XXX-XXX-XX-XX (book-page-parcel-suffix)
    if (!cs.length && p.apn) {
      try { return (await findImpApn(p.digits.slice(0, 6) + '0' + p.digits.slice(6, 8))).map((c) => ({ ...c, sub: c.sub + ' · as old-style ' + p.apn })); } catch (e) { /* SD answer stands */ }
    }
    return cs;
  }
  /** DWR statewide parcel features (Imperial) -> candidates. */
  function impParcelCands(features, src) {
    const by = new Map();
    for (const f of features || []) {
      const a = f.attributes || {}; const apn = String(a.PARCEL_APN || '').trim();
      const rings = f.geometry && f.geometry.rings ? f.geometry.rings.map((r) => r.map(([x, y]) => [y, x])) : [];
      if (!apn) continue;
      if (!by.has(apn)) by.set(apn, { apn, attrs: a, rings: [] });
      by.get(apn).rings.push(...rings);
    }
    return [...by.values()].filter((c) => c.rings.length).map((c) => {
      const [lat, lon] = A.insidePoint(c.rings, c.rings[0][0][0], c.rings[0][0][1]);
      const city = (c.attrs.SITE_CITY || '').trim(), zip = String(c.attrs.SITE_ZIP || '').slice(0, 5);
      const addr = [(c.attrs.SITE_ADDR || '').trim(), [city, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return { kind: 'parcel', src, county: 'imperial', apn: c.apn, lat, lon, rings: c.rings, acreage: null, address: addr, community: city,
        label: src === 'apn' ? `APN ${c.apn}` : (addr || `APN ${c.apn}`),
        sub: src === 'apn' ? [addr || 'no street address on file', 'Imperial County'].join(' · ') : `Imperial parcel APN ${c.apn}` };
    });
  }
  /** Riverside Assessor parcel features -> candidates (APN is 9 undashed digits in GIS). */
  function rivParcelCands(features, src) {
    const by = new Map();
    for (const f of features || []) {
      const a = f.attributes || {}; const apn = fmtApn(a.APN);
      const rings = f.geometry && f.geometry.rings ? f.geometry.rings.map((r) => r.map(([x, y]) => [y, x])) : [];
      if (!by.has(apn)) by.set(apn, { kind: 'parcel', src, apn, attrs: a, rings: [] });
      by.get(apn).rings.push(...rings);
    }
    return [...by.values()].filter((c) => c.rings.length).map((c) => {
      const [lat, lon] = A.insidePoint(c.rings, c.rings[0][0][0], c.rings[0][0][1]);
      const num = c.attrs.STREET_NUMBER != null ? String(c.attrs.STREET_NUMBER) : '';
      const st = [num, c.attrs.STREET_PREDIRECTION, c.attrs.STREET_NAME, c.attrs.STREET_TYPE, c.attrs.STREET_SUFFIX].filter((x) => x && String(x).trim()).join(' ');
      const city = (c.attrs.CITY || '').trim() || (c.attrs.SITUS_CITY || '').split(/\s{2,}/)[0].trim();
      const zip = String(c.attrs.ZIP_CODE || '').slice(0, 5);
      const addr = [st || (c.attrs.SITUS_STREET || '').trim(), [city, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return { kind: 'parcel', src: c.src, apn: c.apn, lat, lon, rings: c.rings, acreage: c.attrs.ACREAGE || null, address: addr,
        community: city, label: src === 'apn' ? `APN ${c.apn}` : (addr || `APN ${c.apn}`),
        sub: src === 'apn' ? [addr || 'no street address yet', c.attrs.ACREAGE ? c.attrs.ACREAGE + ' ac' : '', 'Riverside County'].filter(Boolean).join(' · ')
          : `Riverside parcel APN ${c.apn}${c.attrs.ACREAGE ? ' · ' + c.attrs.ACREAGE + ' ac' : ''}` };
    });
  }
  /** County parcel layer by situs address (exact parcel). Only when the input starts with a house number. */
  async function findSitus(a) {
    const m = a.street.match(/^(\d{1,6})\s+(.+)$/);
    if (!m) return [];
    if (a.imperial) return findImpSitus(a, m);
    let words = m[2].replace(/[#].*$/, '').replace(/\b(APT|UNIT|STE|SUITE|SPC|SPACE)\b.*$/, '').replace(/[^A-Z0-9' ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length > 1 && DIRS.has(words[0])) words = words.slice(1);
    if (words.length > 1 && SUFFIX.has(words[words.length - 1])) words = words.slice(0, -1);
    if (words.length > 1 && DIRS.has(words[words.length - 1])) words = words.slice(0, -1);
    const name = words.join(' ');
    if (!name || name.length < 2) return [];
    const conds = [`SITUS_ADDRESS=${+m[1]}`, `SITUS_STREET LIKE '${sqlStr(name)}%'`];
    // place filter: the ZIP(s), or the parcel layer's community name (some parcels have no ZIP)
    const zc = a.zips.slice(0, 12).map((z) => `SITUS_ZIP LIKE '${z}%'`);
    if (a.community && !a.zip) zc.push(`SITUS_COMMUNITY='${sqlStr(a.community)}'`);
    if (zc.length) conds.push('(' + zc.join(' OR ') + ')');
    const j = await getJson(C.parcels.url, { where: conds.join(' AND '), outFields: PARCEL_FIELDS, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', resultRecordCount: '12', f: 'json' });
    return parcelCands(j.features, 'situs');
  }
  /** Imperial: DWR parcel layer situs (house number + street name start, in the ZIP(s) / town). */
  async function findImpSitus(a, m) {
    const IP = C.imperialParcels;
    if (!IP) return [];
    let words = m[2].replace(/[#].*$/, '').replace(/\b(APT|UNIT|STE|SUITE|SPC|SPACE)\b.*$/, '').replace(/[^A-Z0-9' ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    const dir = words.length > 1 && DIRS.has(words[0]) ? words[0].charAt(0) : '';
    if (dir) words = words.slice(1);
    if (words.length > 1 && SUFFIX.has(words[words.length - 1])) words = words.slice(0, -1);
    if (words.length > 1 && DIRS.has(words[words.length - 1])) words = words.slice(0, -1);
    const name = words.join(' ');
    if (!name || name.length < 2) return [];
    const conds = [IP.where, `SITE_HOUSE_NUMBER='${+m[1]}'`, `SITE_STREET_NAME LIKE '${sqlStr(name)}%'`];
    const zc = a.zips.slice(0, 12).map((z) => `SITE_ZIP='${z}'`);
    if (a.community && !a.zip) zc.push(`SITE_CITY='${sqlStr(a.community)}'`);
    if (zc.length) conds.push('(' + zc.join(' OR ') + ')');
    const j = await getJson(IP.url, { where: conds.join(' AND '), outFields: IP.outFields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', resultRecordCount: '12', f: 'json' });
    const cs = impParcelCands(j.features, 'situs');
    // "600 E Main St": keep the E one when both E and W Main St parcels match (the query ignores the direction)
    const sameDir = dir ? cs.filter((c) => new RegExp(`^${+m[1]}\\s+${dir}\\b`).test(c.address)) : [];
    return sameDir.length ? sameDir : cs;
  }
  const IB = G.imperialBounds || [32.61, -116.11, 33.44, -114.46];
  const inImperial = (lat, lon) => lat >= IB[0] && lat <= IB[2] && lon >= IB[1] && lon <= IB[3];
  /** Imperial: California statewide locator (knows city names), kept to Imperial County. */
  async function findImpGeocoder(a) {
    if (!G.imperialGeocoderUrl) return [];
    const place = a.zips.length === 1 ? (a.community ? `${a.community}, CA ${a.zips[0]}` : `CA ${a.zips[0]}`) : (a.community ? `${a.community}, CA` : 'Imperial County, CA');
    const j = await getJson(G.imperialGeocoderUrl, { SingleLine: `${a.street}, ${place}`, outSR: '4326', maxLocations: String(G.maxCandidates), outFields: 'Addr_type,ZIP,City,Score', f: 'json' });
    let cs = (j.candidates || []).filter((c) => c.location && c.score >= G.minScore && inImperial(c.location.y, c.location.x)).map((c) => {
      const at = c.attributes || {};
      return { kind: 'geocode', county: 'imperial', lat: +c.location.y.toFixed(6), lon: +c.location.x.toFixed(6), score: c.score,
        type: at.Addr_type === 'Address' ? 'PointAddress' : at.Addr_type,   // 'Address' = a parcel / address point in this locator
        zip: String(at.ZIP || (c.address.match(/\b(9\d{4})\b/) || [])[1] || ''),
        label: String(c.address || '').replace(/, CA,? /, ' ').replace(/\s+/g, ' ').toUpperCase(), sub: 'Imperial County · California address locator' };
    });
    if (a.zips.length) { const inZ = cs.filter((c) => a.zips.includes(c.zip)); if (inZ.length) cs = inZ; else cs.forEach((c) => (c.elsewhere = true)); }
    // this locator returns the near-misses too (600 W Main for 600 E Main, 601 E Main): keep those close to the best score
    const top = Math.max(0, ...cs.map((c) => c.score));
    return cs.filter((c) => c.score >= top - 5);
  }
  /** A place typed with no street: Imperial town centre, or a named SD spot that is a small part of a big ZIP. */
  function placeOnly(a) {
    const ip = IMP[a.community] || (!a.community && a.zip && Object.values(IMP).find((p) => p.zips.includes(a.zip)));
    if (ip && (a.imperial || IMP[a.community])) {
      const name = a.community || Object.keys(IMP).find((n) => IMP[n] === ip);
      const z = a.zip || ip.zips[0] || '';
      const hint = name === 'OCOTILLO' ? ' (for the San Diego County one, type Ocotillo Wells)' : '';
      return [{ kind: 'geocode', county: 'imperial', type: 'Postal', lat: ip.ll[0], lon: ip.ll[1], score: 100, zip: z, label: `${name}${z ? ' ' + z : ''}`, sub: `Imperial County · town centre${hint}` }];
    }
    const pc = (G.placeCenters || {})[a.community];
    if (pc && !a.zip) return [{ kind: 'geocode', type: 'Postal', lat: pc[0], lon: pc[1], score: 100, zip: (a.zips || [])[0] || '', label: `${a.community} ${(a.zips || [])[0] || ''}`.trim(), sub: 'San Diego County · place centre' }];
    return null;
  }
  /** SANDAG regional locator. It knows ZIPs but not city names, hence street + ZIP. */
  async function findGeocoder(a) {
    const one = async (q) => {
      const j = await getJson(G.geocoderUrl, { SingleLine: q, outSR: '4326', maxLocations: String(G.maxCandidates), outFields: 'Addr_type,Postal,Score', f: 'json' });
      return (j.candidates || []).filter((c) => c.location && c.score >= G.minScore && inCounty(c.location.y, c.location.x)).map((c) => ({
        kind: 'geocode', lat: +c.location.y.toFixed(6), lon: +c.location.x.toFixed(6), score: c.score, type: c.attributes && c.attributes.Addr_type,
        zip: String((c.attributes && c.attributes.Postal) || (c.address.match(/\b(9\d{4})\b/) || [])[1] || ''),
        label: placeLabel(c.address),
      }));
    };
    if (!a.street) {   // just a community or ZIP: the ZIP area's centre (County ZIP locator)
      const po = placeOnly(a);
      if (po) return po;
      if (!a.zips.length || a.zips.length > 12) return [];
      const r = await Promise.all(a.zips.slice(0, 8).map((z) => getJson(G.zipUrl, { ZIP: z, outSR: '4326', f: 'json' }).then((j) => (j.candidates || [])[0]).catch(() => null)));
      return r.filter((c) => c && c.location && inCounty(c.location.y, c.location.x)).map((c) => ({ kind: 'geocode', type: 'Postal', lat: +c.location.y.toFixed(6), lon: +c.location.x.toFixed(6),
        score: 100, zip: c.address, label: `${a.community || zipPlace(c.address) || 'ZIP'} ${c.address}`, sub: 'centre of the ZIP code area' }));
    }
    if (a.imperial) return findImpGeocoder(a);   // SANDAG is SD-only
    let cs = a.zips.length === 1 ? await one(`${a.street} ${a.zips[0]}`) : [];
    if (cs.length) return cs;
    cs = await one(a.street);
    if (a.zips.length) { const inZ = cs.filter((c) => a.zips.includes(c.zip)); if (inZ.length) cs = inZ; else cs.forEach((c) => (c.elsewhere = true)); }
    // Southern Riverside (Aguanga / Sage / Temecula): SANDAG is SD-only — try the RivCo geocoder when needed.
    const rivZips = new Set(['92536', '92539', '92543', '92544', '92545', '92546', '92549', '92562', '92563', '92564', '92590', '92591', '92592', '92593']);
    const wantRiv = (a.zips || []).some((z) => rivZips.has(z)) || /AGUANGA|SAGE|ANZA|TEMECULA|MURRIETA|HEMET|IDYLLWILD|LAKE RIVERSIDE/.test(a.community || '');
    if ((!cs.length || cs.every((c) => c.elsewhere)) && G.riversideGeocoderUrl && (wantRiv || !cs.length)) {
      try {
        const q = a.zips.length === 1 ? `${a.street} ${a.zips[0]}` : (a.community ? `${a.street}, ${a.community}` : a.street);
        const j = await getJson(G.riversideGeocoderUrl, { SingleLine: q, outSR: '4326', maxLocations: String(G.maxCandidates), f: 'json' });
        const RB = G.riversideBounds || [33.35, -117.45, 34.15, -116.05];
        const inRiv = (lat, lon) => lat >= RB[0] && lat <= RB[2] && lon >= RB[1] && lon <= RB[3];
        const riv = (j.candidates || []).filter((c) => c.location && c.score >= G.minScore && inRiv(c.location.y, c.location.x)).map((c) => ({
          kind: 'geocode', lat: +c.location.y.toFixed(6), lon: +c.location.x.toFixed(6), score: c.score, type: 'PointAddress',
          zip: String((c.address.match(/\b(9\d{4})\b/) || [])[1] || ''),
          label: placeLabel(c.address), sub: 'Riverside County geocoder',
        }));
        if (riv.length) return riv;
      } catch (e) { /* RivCo geocoder optional */ }
    }
    // nothing in SD / Riverside and no place given: maybe an Imperial address typed without its town
    if (!cs.length && !a.community && !a.zip) { try { cs = await findImpGeocoder(a); } catch (e) { /* optional */ } }
    return cs;
  }
  // ZIP -> postal community name, for labels ("1521 E MAIN ST, 92021" -> "1521 E MAIN ST, EL CAJON 92021")
  const ZIP_PLACE = {}; for (const [n, zs] of Object.entries(COMM)) for (const z of zs) if (!ZIP_PLACE[z]) ZIP_PLACE[z] = n;
  const zipPlace = (z) => ZIP_PLACE[z] || '';
  const placeLabel = (addr) => String(addr || '').replace(/, CA,/, ',').replace(/\s+/g, ' ').replace(/(,\s*)(9[12]\d{3})$/, (m, c, z) => `${c}${zipPlace(z) ? zipPlace(z) + ' ' : ''}${z}`);
  const B = G.countyBounds;  // [south, west, north, east]
  const inCounty = (lat, lon) => lat >= B[0] && lat <= B[2] && lon >= B[1] && lon <= B[3];
  /** "1521 MAIN ST, RAMONA 92065" -> "1521 MAIN ST" (an interpolated street point can sit outside a big parcel). */
  const streetKey = (label) => { const m = String(label || '').split(',')[0].trim().toUpperCase(); return /^\d+\s+\S/.test(m) ? m.replace(/\s+/g, ' ') : ''; };
  const distM = (a, b) => map.distance([a.lat, a.lon], [b.lat, b.lon]);
  const TYPE_RANK = { PointAddress: 0, StreetAddress: 1, StreetInt: 2, StreetName: 3, Postal: 4 };

  async function lookup(raw) {
    const p = parseApn(raw);
    if (p && p.bad) return { msg: `An APN has 10 digits (SD: XXX-XXX-XX-XX), 9 (Riverside / Imperial: XXX-XXX-XXX), 12 (Imperial: XXX-XXX-XXX-XXX), or 8 (SD: XXX-XXX-XX); that one has ${p.bad}.` };
    if (p) {
      const cs = await findApn(p);
      const shown = p.apn || p.apn9 || p.apn8 || p.apn12;
      const where = p.apn9 ? 'Riverside or Imperial County parcel layers' : p.apn12 ? 'Imperial County parcel layer' : 'San Diego County parcel layer';
      if (!cs.length) return { msg: `APN ${esc(shown)} was not found in the ${where}. Check the number (new parcel splits can take a while to appear).` };
      return { cands: cs, kind: 'apn' };
    }
    const a = parseAddress(raw);
    if (!a.street && !a.zips.length) return { msg: 'Type a street address (e.g. 729 Main St, Ramona) or an APN (285-030-06-00).' };
    const [g, s] = await Promise.allSettled([findGeocoder(a), findSitus(a)]);
    if (g.status === 'rejected' && s.status === 'rejected') throw new Error(g.reason && g.reason.message || 'lookup failed');
    let parcels = s.status === 'fulfilled' ? s.value : [];
    let geos = g.status === 'fulfilled' ? g.value : [];
    if (a.imperial) {
      // the statewide parcel layer has some situs addresses on the wrong parcel (e.g. "600 E Main St, El Centro" on a parcel
      // near Calipatria): drop a parcel far from the town typed, or far from the locator's point for the same address
      const town = IMP[a.community];
      parcels = parcels.filter((c) => (!town || map.distance([c.lat, c.lon], town.ll) < 20000)
        && !geos.some((x) => !x.elsewhere && streetKey(x.label) && streetKey(x.label) === streetKey(c.label) && distM(x, c) > G.sameAddressM));
    }
    geos.sort((x, y) => (y.score - x.score) || ((TYPE_RANK[x.type] ?? 5) - (TYPE_RANK[y.type] ?? 5)));
    // drop geocoder hits that are the same place as a parcel hit (the parcel one carries the APN), and geocoder duplicates
    const out = [...parcels];
    for (const c of geos) {
      if (out.some((o) => distM(o, c) < G.dedupeM || (o.kind === 'parcel' && o.rings && pointIn(o.rings, c.lat, c.lon))
        || (streetKey(o.label) && streetKey(o.label) === streetKey(c.label) && distM(o, c) < G.sameAddressM))) continue;
      out.push(c);
    }
    if (!out.length) return { msg: `No match for “${esc(raw)}” in San Diego / southern Riverside / Imperial. Check the spelling, add the town or ZIP code, or try the APN.` };
    const cands = out.slice(0, G.maxShown);
    const vague = /^\d/.test(a.street) && !cands.some((c) => c.kind === 'parcel' || ['PointAddress', 'StreetAddress', 'StreetInt'].includes(c.type));
    const note = cands.every((c) => c.elsewhere) ? `Nothing found in ${esc(a.community || 'ZIP ' + a.zip)}; matches elsewhere in the ${a.imperial ? 'Imperial ' : ''}county:`
      : vague ? 'That house number was not found — the street only:' : '';
    return { cands, kind: 'address', note };
  }
  function pointIn(rings, lat, lon) {
    let inside = false;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [yi, xi] = r[i], [yj, xj] = r[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------------------------------------------------------------- recent searches (this device only)
  function loadRecent() { try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function saveRecent(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, G.recentMax))); } catch (e) { /* private mode */ } }
  function addRecent(c, q) {
    const r = { q: String(q).trim(), label: c.label, sub: c.sub || '', lat: c.lat, lon: c.lon, apn: c.apn || null, kind: c.apn && c.src === 'apn' ? 'apn' : 'address', t: Date.now() };
    saveRecent([r, ...loadRecent().filter((x) => x.label !== r.label && x.q.toUpperCase() !== r.q.toUpperCase())]);
  }

  // ---------------------------------------------------------------- map pin + outline
  const pinLayer = L.layerGroup().addTo(map);
  let pinAt = null;
  function showPin(c) {
    pinLayer.clearLayers();
    if (c.rings) L.polygon(c.rings, { color: '#f472b6', weight: 3, fill: false, dashArray: '6 4', interactive: false }).addTo(pinLayer);
    const m = L.marker([c.lat, c.lon], { icon: L.divIcon({ className: '', html: '<div class="as-pin"><span>🔎</span></div>', iconSize: [30, 36], iconAnchor: [15, 33], popupAnchor: [0, -30] }), zIndexOffset: 1200 })
      .bindPopup(() => `<div class="popup"><h3>${esc(c.label)}</h3>${c.sub ? esc(c.sub) + '<br>' : ''}<small class="muted">${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</small></div>`).addTo(pinLayer);
    pinAt = { lat: c.lat, lon: c.lon, marker: m };
  }
  function clearPin() { pinLayer.clearLayers(); pinAt = null; }
  /** For an address hit, look up its parcel (APN + outline) for the pin; never blocks the search. */
  async function enrichPin(c) {
    if (c.apn) return;
    if (c.county === 'imperial' || (inImperial(c.lat, c.lon) && !inCounty(c.lat, c.lon))) return enrichImpPin(c);
    if (!window.WellsSites) return;
    try {
      const p = await WellsSites.lookupParcel(c.lat, c.lon);
      if (!pinAt || pinAt.lat !== c.lat || pinAt.lon !== c.lon || !p || !p.found) return;
      c.apn = p.apn; c.rings = p.rings; c.sub = `parcel APN ${p.apn}${p.acreage ? ' · ' + p.acreage + ' ac' : ''}`;
      showPin(c);
    } catch (e) { /* offline: pin stays without APN */ }
  }

  async function enrichImpPin(c) {
    const IP = C.imperialParcels;
    if (!IP || c.type === 'Postal') return;
    try {
      const j = await getJson(IP.url, { where: IP.where, geometry: `${c.lon},${c.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: IP.outFields, returnGeometry: 'true', outSR: '4326', geometryPrecision: '6', f: 'json' });
      const p = impParcelCands(j.features, 'situs')[0];
      if (!pinAt || pinAt.lat !== c.lat || pinAt.lon !== c.lon || !p) return;
      c.apn = p.apn; c.rings = p.rings; c.sub = `Imperial parcel APN ${p.apn}`;
      showPin(c);
    } catch (e) { /* offline: pin stays without APN */ }
  }

  // ---------------------------------------------------------------- UI
  const box = L.DomUtil.create('div', 'addr-search', map.getContainer());
  box.innerHTML = `<form class="as-bar" role="search" autocomplete="off">
      <input type="search" class="as-input" enterkeyhint="search" autocapitalize="characters" autocorrect="off" spellcheck="false"
        placeholder="Address or APN" aria-label="Search an address or APN (San Diego, Riverside or Imperial County)">
      <button type="button" class="as-clear" aria-label="Clear" hidden>✕</button>
      <button type="submit" class="as-go" aria-label="Search">🔍</button>
    </form>
    <div class="as-drop" hidden></div>`;
  L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
  const form = box.querySelector('form'), input = box.querySelector('.as-input'), drop = box.querySelector('.as-drop'), clr = box.querySelector('.as-clear'), go = box.querySelector('.as-go');
  let seq = 0, lastCands = [], lastQ = '';

  function openDrop(html) { drop.innerHTML = html; drop.hidden = !html; box.classList.toggle('open', !!html); }
  function closeDrop() { openDrop(''); }
  function busy(on) { go.disabled = on; go.textContent = on ? '⏳' : '🔍'; }
  function renderRecent() {
    const q = input.value.trim().toUpperCase();
    const rs = loadRecent().map((r, i) => ({ ...r, i })).filter((r) => !q || r.q.toUpperCase().includes(q) || r.label.toUpperCase().includes(q));
    if (!rs.length) return closeDrop();
    openDrop(`<div class="as-head">Recent <button type="button" class="as-clr-recent">Clear</button></div>${rs.map((r) =>
      `<div class="as-row" data-r="${r.i}"><button type="button" class="as-pick">${r.kind === 'apn' ? '🏷️' : '🏠'} <b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</button><button type="button" class="as-del" aria-label="Remove">✕</button></div>`).join('')}`);
  }
  function renderCands(res) {
    lastCands = res.cands;
    openDrop(`<div class="as-head">${res.note || `${res.cands.length} matches — pick one`}</div>${res.cands.map((c, i) =>
      `<div class="as-row" data-c="${i}"><button type="button" class="as-pick">${c.kind === 'parcel' ? '🏷️' : '📍'} <b>${esc(c.label)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : c.type ? `<small>${esc(typeLabel(c.type))}</small>` : ''}</button></div>`).join('')}`);
  }
  const typeLabel = (t) => ({ PointAddress: 'address point', StreetAddress: 'address on street (interpolated)', StreetInt: 'intersection', StreetName: 'street (middle)', Postal: 'ZIP code area' }[t] || t);
  function message(html, kind) { openDrop(`<div class="as-msg ${kind || ''}">${html}</div>`); }

  function choose(c, q) {
    closeDrop(); input.blur();
    showPin(c);
    addRecent(c, q || c.label);
    A.setLocation(c.lat, c.lon, c.apn && c.src === 'apn' ? `APN ${c.apn}` : `Address: ${c.label}`);
    enrichPin(c);
  }
  async function run() {
    const q = input.value.trim();
    if (!q) return renderRecent();
    const id = ++seq; lastQ = q;
    busy(true); message(parseApn(q) ? 'Looking up the parcel…' : 'Looking up the address…');
    try {
      const res = await lookup(q);
      if (id !== seq) return;
      if (res.msg) return message(res.msg, 'warn');
      // one hit, or one precise hit (parcel / address / intersection) next to vaguer ones (whole street, ZIP area): go straight there
      const precise = res.cands.filter((c) => c.kind === 'parcel' || ['PointAddress', 'StreetAddress', 'StreetInt'].includes(c.type));
      if (!res.note && (res.cands.length === 1 || (precise.length === 1 && res.kind === 'address'))) return choose(precise[0] || res.cands[0], q);
      renderCands(res);
    } catch (e) {
      if (id !== seq) return;
      message(`${navigator.onLine === false ? '📵 No signal — ' : ''}Lookup failed (${esc(e.message || e)}). <button type="button" class="as-retry">↻ Retry</button>`, 'err');
    } finally { if (id === seq) busy(false); }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  input.addEventListener('focus', () => { if (!input.value.trim()) renderRecent(); });
  input.addEventListener('input', () => { clr.hidden = !input.value; seq++; busy(false); renderRecent(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrop(); input.blur(); } });
  clr.addEventListener('click', () => { input.value = ''; clr.hidden = true; seq++; busy(false); clearPin(); input.focus(); renderRecent(); });
  drop.addEventListener('click', (e) => {
    // the handlers below re-render the list, detaching the tapped button; Leaflet would then no longer see that the click
    // came from inside this box and would treat it as a map tap (opening a "Search here" popup), so stop it here
    e.stopPropagation();
    const t = e.target;
    if (t.closest('.as-retry')) return run();
    if (t.closest('.as-clr-recent')) { saveRecent([]); return closeDrop(); }
    const row = t.closest('.as-row'); if (!row) return;
    if (row.dataset.c != null) { const c = lastCands[+row.dataset.c]; if (c) { input.value = c.label; clr.hidden = false; choose(c, lastQ); } return; }
    const list = loadRecent(), r = list[+row.dataset.r]; if (!r) return;
    if (t.closest('.as-del')) { list.splice(+row.dataset.r, 1); saveRecent(list); return renderRecent(); }
    input.value = r.q; clr.hidden = false;
    // re-use the saved spot (works with no signal); the APN outline is fetched again in the background
    const c = { kind: r.apn ? 'parcel' : 'geocode', src: r.kind === 'apn' ? 'apn' : 'situs', apn: r.apn, label: r.label, sub: r.sub, lat: r.lat, lon: r.lon };
    choose(c, r.q);
    if (r.kind === 'apn') findApn(parseApn(r.apn) || {}).then((cs) => { const f = cs.find((x) => x.apn === r.apn); if (f && pinAt && pinAt.lat === r.lat && pinAt.lon === r.lon) { c.rings = f.rings; showPin(c); } }).catch(() => {});
    else if (r.apn) WellsSites && WellsSites.lookupParcel(r.lat, r.lon).then((p) => { if (p && p.found && pinAt && pinAt.lat === r.lat) { c.rings = p.rings; showPin(c); } }).catch(() => {});
  });
  // tapping the map / elsewhere closes the list
  document.addEventListener('pointerdown', (e) => { if (!box.contains(e.target)) closeDrop(); }, true);

  /** Called by the app whenever the search point moves: a pin left from an earlier search goes away. */
  function onLocation(lat, lon) { if (pinAt && map.distance([lat, lon], [pinAt.lat, pinAt.lon]) > 2) clearPin(); }

  window.WellsSearch = { parseApn, parseAddress, lookup, run, choose, onLocation, clearPin, get input() { return input; } };
})();
