/* Wells Nearby — San Diego County DEHQ document library lookups (on tap, cached). */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG;
  const cache = new Map();

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
    const apn = (c && c.apn) || w.apn;
    if (apn && !/^0+[-0]*$/.test(apn)) q.push({ type: 'parcel_number', value: apn.split(',')[0].trim(), label: 'APN ' + apn.split(',')[0].trim(), secondary: true });
    return q;
  }

  async function search(type, value) {
    const L = C.docLibrary;
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
        return (j.records || []).map((d) => ({
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

  global.WellsDocs = { docQueries, search };
})(typeof window !== 'undefined' ? window : globalThis);
