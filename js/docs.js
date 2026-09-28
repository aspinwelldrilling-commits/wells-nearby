/* Wells Nearby — San Diego County DEHQ document library lookups (on tap, cached). */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG;
  const cache = new Map();

  /** County APN in the library's exact format "XXX-XXX-XX-XX" (10 digits). An 8-digit APN (no suffix) gives the
   *  prefix "XXX-XXX-XX", which the library matches as a prefix (results are then filtered to that book/page/parcel). */
  function apnFull(v) {
    const d = String(v == null ? '' : v).split(',')[0].replace(/\D/g, '');
    if (d.length >= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}`;
    if (d.length === 8) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}`;
    return null;
  }
  /** The library matches record_id and parcel_number as PREFIXES (record_id=DEH1981-LWELL-997 also returns
   *  DEH1981-LWELL-9972). Keep only exact hits. */
  function exactFilter(type, value, recs) {
    if (type === 'record_id') {
      const v = String(value).trim().toUpperCase();
      return recs.filter((d) => !d.permit_id || String(d.permit_id).trim().toUpperCase() === v);
    }
    if (type === 'parcel_number') {
      const q = String(value).replace(/\D/g, '');
      if (q.length < 8) return recs;
      return recs.filter((d) => {
        const a = String(d.parcel_nbr || '').replace(/\D/g, '');
        return !a || (q.length >= 10 ? a.slice(0, 10) === q.slice(0, 10) || a === q.slice(0, 8) : a.slice(0, 8) === q);
      });
    }
    return recs;
  }

  /** Candidate county record IDs for a well (county permit, matched permit, or state permit # + permit year). */
  function docQueries(w) {
    const q = [];
    const c = w.group === 'county' ? w : w.group === 'both' ? w.county : (w.match && w.match.county);
    if (c && c.permit) q.push({ type: 'record_id', value: c.permit, label: c.permit });
    if (!q.length && w.permit) {
      // State WCR permit "LWEL 15082" + permit year 2002 -> "DEH2002-LWELL-15082" (6-digit padding from 2013 on).
      const m = String(w.permit).toUpperCase().match(/(?:LWEL+|DEH\d{0,4})[-\s]*(?:LWELL[-\s]*)?0*(\d+)\s*$/);
      const y = w.permitDateMs != null ? new Date(w.permitDateMs).getUTCFullYear() : w.year;
      if (m && y) {
        const id = `DEH${y}-LWELL-${y >= 2013 ? m[1].padStart(6, '0') : m[1]}`;
        q.push({ type: 'record_id', value: id, label: id, guessed: true });
      }
    }
    const apn = apnFull((c && c.apn) || w.apn);
    if (apn && !/^[0-]+$/.test(apn)) q.push({ type: 'parcel_number', value: apn, label: 'APN ' + apn, secondary: true });
    return q;
  }

  async function search(type, value) {
    const L = C.docLibrary;
    if (type === 'parcel_number') value = apnFull(value) || value;
    const key = type + '=' + value.toUpperCase();
    if (cache.has(key)) return cache.get(key);
    // NOTE: responses served from the county's cache layer omit the CORS header, so (like the county's own
    // search page) we add a unique ts= parameter to always hit the origin, and retry once on failure.
    const mkUrl = () => `${L.searchApi}?${type}=${encodeURIComponent(value.toUpperCase())}&doc_category=${L.category}&maxrecord_count=${L.maxRecords}&ts=${Date.now()}`;
    const once = async () => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), L.timeoutMs);
      try {
        const r = await fetch(mkUrl(), { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(t); }
    };
    const p = (async () => {
      {
        let j;
        try { j = await once(); } catch (e) { await new Promise((res) => setTimeout(res, 1200)); j = await once(); }
        return exactFilter(type, value, j.records || []).map((d) => ({
          url: d.url, permit: d.permit_id, apn: d.parcel_nbr, subtype: (d.lueg_subtype || '').replace(/^DEH-LWQD-/, ''),
          description: d.description || '', scanned: (d.r_creation_date || '').slice(0, 10), sizeKb: Math.round((+d.r_content_size || 0) / 1024),
          type: d.a_content_type, isWcr: /wcr|completion|log/i.test(d.description || ''),
        })).sort((a, b) => (a.scanned < b.scanned ? 1 : -1));
      }
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
  }

  /** Raw library search with any criteria, e.g. {parcel_number: '284-291-60'} or {street_number, street_name}, plus
   *  subtypes ['DEH-LWQD-OWTS Layout', ...]. Returns the raw records. Cached per criteria; ts= cache-buster for CORS. */
  const rawCache = new Map();
  function searchRaw(criteria, subtypes) {
    const L = C.docLibrary;
    criteria = { ...criteria };
    if (criteria.parcel_number) criteria.parcel_number = apnFull(criteria.parcel_number) || criteria.parcel_number;
    const parts = Object.entries(criteria).map(([k, v]) => `${k}=${encodeURIComponent(String(v).trim().toUpperCase())}`);
    parts.push(`doc_category=${L.category}`);
    if (subtypes && subtypes.length) parts.push('doc_subcategory=' + subtypes.map(encodeURIComponent).join(','));
    parts.push(`maxrecord_count=${L.maxRecords}`);
    const key = parts.join('&');
    if (rawCache.has(key)) return rawCache.get(key);
    const once = async () => {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), L.timeoutMs);
      try {
        const r = await fetch(`${L.searchApi}?${key}&ts=${Date.now()}`, { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(t); }
    };
    const p = (async () => {
      let j;
      try { j = await once(); } catch (e) { await new Promise((res) => setTimeout(res, 1200)); j = await once(); }
      let recs = j.records || [];
      for (const t of ['record_id', 'parcel_number']) if (criteria[t]) recs = exactFilter(t, criteria[t], recs);
      return recs;
    })();
    rawCache.set(key, p);
    p.catch(() => rawCache.delete(key));
    return p;
  }

  global.WellsDocs = { docQueries, search, searchRaw, apnFull, exactFilter };
})(typeof window !== 'undefined' ? window : globalThis);
