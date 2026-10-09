/* ⓘ About / data disclaimer + 💬 Send feedback.
 * - ⓘ About (top bar) opens a small panel: where the well data comes from, its limits, and that private data stays on the device.
 * - A one-time first-visit notice under the top bar (dismissal remembered in localStorage).
 * - 💬 Feedback (top bar + About panel) opens a pre-filled email to FEEDBACK_EMAIL, or, when that is empty, a pre-filled
 *   GitHub issue. The message carries ONLY the app version and the map centre / zoom: never sites, layouts, jobs or customer info. */
(function () {
  'use strict';
  const FEEDBACK_EMAIL = '';   // e.g. 'feedback@example.com'; empty = open a GitHub issue instead
  const ISSUE_URL = 'https://github.com/aspinwelldrilling-commits/wells-nearby/issues/new';
  const APP_VERSION = 'v12';   // keep in step with the cache version in sw.js (wells-nearby-shell-vNN)
  const NOTICE_KEY = 'wellsNearby.noticeDismissed';
  const SUBJECT = 'Wells Nearby feedback';
  const $ = (id) => document.getElementById(id);

  function mapView() {
    const m = window.WellsApp && WellsApp.map;
    if (!m) return 'map not loaded';
    try { const c = m.getCenter(); return `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} (zoom ${m.getZoom()})`; } catch (e) { return 'unknown'; }
  }
  function feedbackBody() {
    return ['What were you trying to do?', '', '', 'What happened?', '', '', 'What would help?', '', '',
      '---', `App version: ${APP_VERSION}`, `Map center: ${mapView()}`, `Screen: ${window.innerWidth}x${window.innerHeight}`].join('\n');
  }
  function feedbackHref() {
    const body = feedbackBody();
    if (FEEDBACK_EMAIL) return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(SUBJECT)}&body=${encodeURIComponent(body)}`;
    return `${ISSUE_URL}?${new URLSearchParams({ title: SUBJECT, body })}`;
  }
  // every feedback link gets a fresh href (current map view) right before it is followed
  function wireFeedback(a) {
    if (!FEEDBACK_EMAIL) { a.target = '_blank'; a.rel = 'noopener'; }
    const upd = () => { a.href = feedbackHref(); };
    upd(); a.addEventListener('click', upd); a.addEventListener('pointerdown', upd); a.addEventListener('focus', upd);
  }

  // ---------------------------------------------------------------- top bar buttons
  const bar = document.querySelector('.topbar');
  const tools = document.createElement('span'); tools.className = 'tb-tools';
  tools.innerHTML = '<a id="btnFeedbackTop" class="tb-btn" href="#">💬 Feedback</a><button type="button" id="btnAbout" class="tb-btn" aria-haspopup="dialog">ⓘ About</button>';
  bar.appendChild(tools);
  wireFeedback($('btnFeedbackTop'));

  // ---------------------------------------------------------------- About panel (modal)
  const where = 'San Diego, Riverside, Los Angeles and Imperial counties, plus the state DWR OSWCR database';
  const ov = document.createElement('div'); ov.id = 'aboutPanel'; ov.className = 'about-ov hidden';
  ov.innerHTML = `<div class="about-box" role="dialog" aria-modal="true" aria-labelledby="aboutTitle">
    <div class="sheet-head"><b id="aboutTitle">ⓘ About this data</b><button type="button" class="small" id="aboutClose">Close</button></div>
    <p>Well data comes from public county and state records (${where}). It may be <b>incomplete, out of date or mislocated</b>, and many older scans are hard to read.</p>
    <p><b>Use it as a research aid only and verify in the field. Not an official record.</b></p>
    <p>🔒 Your drawings, septic layouts and any job data you add stay on your own device and are never uploaded.</p>
    <p class="muted about-small">Address / APN lookups send only the typed search, APN or coordinates to public County / State map services. More detail is in the notes at the bottom of the page. App ${APP_VERSION}.</p>
    <a id="btnFeedbackAbout" class="about-fb" href="#">💬 Send feedback</a>
  </div>`;
  document.body.appendChild(ov);
  wireFeedback($('btnFeedbackAbout'));
  let lastFocus = null;
  function openAbout() { lastFocus = document.activeElement; ov.classList.remove('hidden'); $('aboutClose').focus(); }
  function closeAbout() { ov.classList.add('hidden'); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  $('btnAbout').addEventListener('click', openAbout);
  $('aboutClose').addEventListener('click', closeAbout);
  ov.addEventListener('click', (e) => { if (e.target === ov) closeAbout(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ov.classList.contains('hidden')) closeAbout(); });

  // ---------------------------------------------------------------- first-visit notice
  let dismissed = false;
  try { dismissed = localStorage.getItem(NOTICE_KEY) === '1'; } catch (e) { /* private mode: show it */ }
  if (!dismissed) {
    const n = document.createElement('div'); n.id = 'dataNotice'; n.className = 'data-notice'; n.setAttribute('role', 'note');
    n.innerHTML = `<span>ⓘ Well data is from public county / state records and may be incomplete or mislocated. A research aid only — verify in the field.</span>
      <span class="dn-btns"><button type="button" class="small" id="dnMore">More</button><button type="button" class="small dn-ok" id="dnOk">Got it</button></span>`;
    bar.insertAdjacentElement('afterend', n);
    const dismiss = () => { n.remove(); try { localStorage.setItem(NOTICE_KEY, '1'); } catch (e) { /* */ } };
    $('dnOk').addEventListener('click', dismiss);
    $('dnMore').addEventListener('click', () => { dismiss(); openAbout(); });
  }

  window.WellsAbout = { open: openAbout, close: closeAbout, feedbackHref, FEEDBACK_EMAIL, APP_VERSION };
})();
