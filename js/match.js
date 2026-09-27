/* Wells Nearby — duplicate detection between County DEHQ permits and State WCRs,
 * and construction of the State / County / Both views.
 *
 * A county permit and a state WCR are treated as the same well when:
 *   LIKELY   : same county permit number (e.g. "LWEL 15082" ~ "DEH2002-LWELL-15082") or same APN,
 *              AND the WCR date is within keyWindowDays of the permit date, AND both are (or aren't) destructions
 *   POSSIBLE : same permit#/APN but a date is missing, OR (no conflicting APN) within proxMiles and
 *              WCR date within proxWindowDays of permit date.
 * County layer has no depth, so depth can't be used for matching.
 */
(function (global) {
  'use strict';
  const C = global.WELLS_CONFIG, D = global.WellsData;
  const DAY = 86400000;

  // APN -> "BBBPPPNN" (book-page-parcel). Handles "284-245-19-00", "281-424-0200", "28424519", lists.
  function apnKey(v) {
    if (!v) return null;
    const first = String(v).split(/[,;&]| and /i)[0].trim();
    const parts = first.split(/[-\s]+/).filter(Boolean);
    let k;
    if (parts.length >= 3 && /^\d+$/.test(parts[0])) {
      const par = parts[2].replace(/\D/g, '');
      k = parts[0].padStart(3, '0') + parts[1].replace(/\D/g, '').padStart(3, '0') + (par.length === 3 ? par.slice(1) : par.slice(0, 2)).padStart(2, '0');
    } else {
      const d = first.replace(/\D/g, '');
      k = d.length >= 8 ? d.slice(0, 8) : null;
    }
    return k && /^\d{8}$/.test(k) && !/^0+$/.test(k) ? k : null;
  }

  // County Record_ID "DEH2002-LWELL-15082" -> "15082"; state PermitNumber "LWEL 15082" / "LWELL-000577" / "DEH2015-000945" -> number.
  function permitKey(v, isCounty) {
    if (!v) return null;
    const s = String(v).toUpperCase().trim();
    let m;
    if (isCounty) m = s.match(/LWELL-0*(\d+)$/);
    else m = s.match(/(?:LWEL+|DEH\d{0,4})[-\s]*(?:LWELL[-\s]*)?0*(\d+)\s*$/) || s.match(/^0*(\d{3,6})$/);
    return m ? m[1] : null;
  }

  function within(x, [lo, hi]) { return x != null && x >= lo && x <= hi; }

  function findMatches(stateRecs, countyRecs) {
    const M = C.matching;
    stateRecs.forEach((s) => { s.match = null; s._apn = apnKey(s.apn); s._pk = permitKey(s.permit, false); });
    countyRecs.forEach((c) => { c.matches = []; c._apn = apnKey(c.apn); c._pk = permitKey(c.permit, true); });
    const cands = [];
    for (const c of countyRecs) {
      for (const s of stateRecs) {
        if (!!c.destruction !== !!s.destruction) continue;
        const byPermit = c._pk && s._pk && c._pk === s._pk;
        const byApn = c._apn && s._apn && c._apn === s._apn;
        const sDate = byPermit && s.permitDateMs != null ? s.permitDateMs : (s.dateMs ?? s.permitDateMs);
        const dt = sDate != null && c.dateMs != null ? (sDate - c.dateMs) / DAY : null;
        if (byPermit || byApn) {
          const reason = [byPermit && 'permit #', byApn && 'APN'].filter(Boolean).join(' + ');
          if (within(dt, M.keyWindowDays)) cands.push({ c, s, conf: 'likely', score: 3 + (byPermit && byApn ? 1 : 0) - Math.abs(dt) / 3650, reason: `${reason}, dates ${Math.round(dt)} d apart`, key: true });
          else if (dt == null) cands.push({ c, s, conf: 'possible', score: 1.5, reason: `${reason} (date missing)`, key: true });
          continue; // same parcel/permit number but dates far apart: different well
        }
        if (s._apn && c._apn && s._apn !== c._apn) continue; // conflicting APNs
        if (s.lat == null || c.lat == null) continue;
        const dist = D.haversineMi(s.lat, s.lon, c.lat, c.lon);
        if (dist <= M.proxMiles && within(dt, M.proxWindowDays)) {
          cands.push({ c, s, conf: 'possible', score: 1 - dist / M.proxMiles / 2 - Math.abs(dt) / 1000, reason: `${dist.toFixed(2)} mi apart, dates ${Math.round(dt)} d apart`, key: false });
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const exclusive = new Set();
    for (const k of cands) {
      if (k.s.match) continue;
      if (exclusive.has(k.c)) continue;
      if (!k.key && k.c.matches.length) continue; // proximity match only for otherwise-unmatched permits
      k.s.match = { county: k.c, conf: k.conf, reason: k.reason };
      k.c.matches.push({ state: k.s, conf: k.conf, reason: k.reason });
      if (!k.key) exclusive.add(k.c);
    }
    // Labels + copy log data onto county records from their best state match.
    for (const s of stateRecs) {
      s.matchLabel = s.match ? (s.match.conf === 'likely' ? 'Likely' : 'Possible') : '';
      s.permitId = s.match ? s.match.county.permit : null;
    }
    for (const c of countyRecs) {
      const best = c.matches[0];
      c.matchLabel = best ? (best.conf === 'likely' ? 'Likely' : 'Possible') + (c.matches.length > 1 ? ` ×${c.matches.length}` : '') : '';
      const s = best && best.state;
      c.wcr = s ? c.matches.map((m) => m.state.wcr).join(', ') : null;
      c.pdfUrl = s ? s.pdfUrl : null;
      for (const f of ['depthFt', 'gpm', 'swlFt', 'yieldZero', 'method', 'fluid', 'casingDiameter', 'perfTop', 'perfBottom', 'driller']) c[f] = s ? s[f] : (f === 'yieldZero' ? false : null);
      if (s) { c.methodKey = s.methodKey; c.methodLabel = s.methodLabel; c.methodColor = s.methodColor; c.methodDetail = s.methodDetail + ' (from WCR)'; }
      else { const n = C.methodCategories.find((x) => x.key === 'nolog'); c.methodKey = n.key; c.methodLabel = n.label; c.methodColor = n.color; c.methodDetail = 'no matched WCR'; }
    }
    return { pairs: stateRecs.filter((s) => s.match).length };
  }

  /** Build the list of wells for a view, limited to radius. Both = state (relocated to parcel if matched) + unmatched county. */
  function buildView(view, stateRecs, countyRecs, radius) {
    const inR = (w) => w.distanceMi != null && w.distanceMi <= radius;
    if (view === 'state') return stateRecs.filter(inR);
    if (view === 'county') return countyRecs.filter(inR);
    const out = [];
    for (const s of stateRecs) {
      if (s.match) {
        const c = s.match.county;
        // Keep the state point only if the WCR reports a precise GPS accuracy; otherwise use the county parcel center.
        const keepState = C.matching.preciseStateAccuracy.test(s.llAccuracy || '');
        out.push(Object.assign({}, s, {
          group: 'both', srcShort: 'Both', county: c, statePoint: [s.lat, s.lon],
          lat: keepState ? s.lat : c.lat, lon: keepState ? s.lon : c.lon, distanceMi: keepState ? s.distanceMi : c.distanceMi,
          llAccuracy: keepState ? s.llAccuracy + ' (state GPS)' : 'Parcel center (county APN) via matched permit',
          address: s.address || c.address, apn: s.apn || c.apn,
        }));
      } else out.push(s);
    }
    for (const c of countyRecs) if (!c.matches.length) out.push(c);
    return out.filter(inR);
  }

  global.WellsMatch = { findMatches, buildView, apnKey, permitKey };
})(typeof window !== 'undefined' ? window : globalThis);
