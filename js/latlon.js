/* Wells Nearby — labeled latitude / longitude shown next to every GPS readout (v30). Display only: nothing saved changes.
 * WellsLL.text(lat, lon)  -> "Lat 33.040000° N  Lon 116.870000° W"
 * WellsLL.long(lat, lon)  -> "Latitude: 33.040000° N   Longitude: 116.870000° W" (plot plan)
 * WellsLL.html(lat, lon)  -> selectable, tap-to-copy <span class="ll-tag">. */
(function () {
  'use strict';
  const ok = (lat, lon) => Number.isFinite(+lat) && Number.isFinite(+lon) && lat !== null && lon !== null;
  const part = (v, pos, neg) => `${Math.abs(+v).toFixed(6)}° ${+v < 0 ? neg : pos}`;
  const text = (lat, lon) => (ok(lat, lon) ? `Lat ${part(lat, 'N', 'S')}  Lon ${part(lon, 'E', 'W')}` : '');
  const long = (lat, lon) => (ok(lat, lon) ? `Latitude: ${part(lat, 'N', 'S')}   Longitude: ${part(lon, 'E', 'W')}` : '');
  const html = (lat, lon) => (ok(lat, lon) ? `<span class="ll-tag" role="button" tabindex="0" title="Tap to copy" data-ll="${text(lat, lon)}">Lat ${part(lat, 'N', 'S')} · Lon ${part(lon, 'E', 'W')}</span>` : '');
  function flash(el, msg) { const o = el.getAttribute('data-ok'); el.setAttribute('data-ok', msg); el.classList.add('copied'); setTimeout(() => { el.classList.remove('copied'); if (o == null) el.removeAttribute('data-ok'); }, 1400); }
  async function copy(el) {
    const t = el.getAttribute('data-ll');
    try { await navigator.clipboard.writeText(t); flash(el, 'Copied'); }
    catch (e) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); flash(el, 'Selected'); }
  }
  document.addEventListener('click', (e) => { const el = e.target.closest && e.target.closest('.ll-tag'); if (el) { e.stopPropagation(); copy(el); } }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('ll-tag')) copy(e.target); });
  window.WellsLL = { text, long, html };
})();
