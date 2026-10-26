/* Wells Nearby — "Back up everything" / "Merge from backup": one JSON file with well sites, septic layouts and My Jobs.
 * Stays on the device; the file only goes where Travis shares/saves it. Merge never deletes or duplicates: same id -> newer wins. */
(function () {
  'use strict';
  const KIND = 'wells-nearby-full-backup', VERSION = 1, LAST = 'wellsNearby.lastBackup';
  function open(name, store, keyPath) {
    return new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function run(name, store, keyPath, mode, fn) {
    const d = await open(name, store, keyPath);
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), q = fn(t.objectStore(store));
      t.oncomplete = () => { d.close(); res(q && 'result' in q ? q.result : undefined); }; t.onerror = () => rej(t.error);
    });
  }
  const S = ['wells-nearby', 'sites', 'id'], L = ['wells-nearby-layouts', 'layouts', 'id'], J = ['wells-nearby-myjobs', 'data', null];
  const all = (x) => run(...x, 'readonly', (s) => s.getAll()).then((a) => a || []);
  const put = (x, v, k) => run(...x, 'readwrite', (s) => (k ? s.put(v, k) : s.put(v)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function backup() {
    const [sites, layouts, jobs] = await Promise.all([all(S), all(L), run(...J, 'readonly', (s) => s.get('jobs'))]);
    const text = JSON.stringify({ app: 'wells-nearby', kind: KIND, version: VERSION, exported: new Date().toISOString(), sites, layouts, myJobs: jobs || null });
    const name = `wells-nearby-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([text], name, { type: 'application/json' });
    let shared = false;
    if (navigator.canShare && navigator.share && /Android|iPhone|iPad/i.test(navigator.userAgent) && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Wells Nearby backup' }); shared = true; } catch (e) { if (e && e.name === 'AbortError') return null; }
    }
    if (!shared) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
    try { localStorage.setItem(LAST, new Date().toISOString()); } catch (e) { /* */ }
    return { sites: sites.length, layouts: layouts.length, jobs: jobs && jobs.jobs ? jobs.jobs.length : 0, bytes: text.length };
  }

  // merge a list by id: newer `updated` wins; returns counts + names changed on both
  async function mergeList(x, incoming, label) {
    const have = new Map((await all(x)).map((r) => [r.id, r])), c = { added: 0, updated: 0, kept: 0, same: 0, differed: [] };
    for (const r of incoming) {
      if (!r || !r.id) continue;
      const cur = have.get(r.id);
      if (!cur) { await put(x, r); c.added++; have.set(r.id, r); continue; }
      if (same(cur, r)) { c.same++; continue; }
      c.differed.push(label(r));
      if ((r.updated || '') > (cur.updated || '')) { await put(x, r); c.updated++; have.set(r.id, r); } else c.kept++;
    }
    return c;
  }
  async function mergeJobs(inc) {
    const c = { added: 0, updated: 0, kept: 0, same: 0, differed: [] };
    if (!inc || !Array.isArray(inc.jobs)) return c;
    const cur = await run(...J, 'readonly', (s) => s.get('jobs'));
    if (!cur || !Array.isArray(cur.jobs)) { await put(J, inc, 'jobs'); c.added = inc.jobs.length; return c; }
    const keys = new Map(cur.jobs.map((j) => [j.key, j]));
    for (const j of inc.jobs) { if (!j || !j.key) continue; const o = keys.get(j.key); if (!o) { cur.jobs.push(j); keys.set(j.key, j); c.added++; } else if (same(o, j)) c.same++; else { c.kept++; c.differed.push(j.name || j.key); } }
    if (c.added) { cur.hasMatches = cur.hasMatches || !!inc.hasMatches; await put(J, cur, 'jobs'); }
    return c;
  }
  async function merge(text) {
    const j = JSON.parse(text), out = {};
    const LC = window.LayoutCore;
    if (j && j.kind === KIND) {
      out.sites = await mergeList(S, (j.sites || []).filter((s) => s && Number.isFinite(+s.lat) && Number.isFinite(+s.lon)), (s) => s.customer || s.id);
      out.layouts = await mergeList(L, (j.layouts || []).map((l) => (LC ? LC.normalize(l) : l)), (l) => l.name || l.id);
      out.jobs = await mergeJobs(j.myJobs);
    } else if (j && (j.kind === 'sites-backup' || (Array.isArray(j) && j[0] && 'lat' in j[0]))) {
      out.sites = await mergeList(S, Array.isArray(j) ? j : j.sites || [], (s) => s.customer || s.id);
    } else if (j && j.kind === 'my-jobs') {
      out.jobs = await mergeJobs(j);
    } else if (LC) {
      out.layouts = await mergeList(L, LC.parseFile(text), (l) => l.name || l.id);
    } else throw new Error('not a Wells Nearby backup file');
    if (window.WellsSites) await WellsSites.refresh();
    if (out.jobs && window.WellsMyJobs && WellsMyJobs.reload) await WellsMyJobs.reload();
    return out;
  }
  function summary(out) {
    const n = { sites: 'Well sites', layouts: 'Septic layouts', jobs: 'My Jobs' }, lines = [];
    for (const k of Object.keys(out)) { const c = out[k]; lines.push(`${n[k]}: added ${c.added}, updated ${c.updated} (newer from file), kept ${c.kept} (yours was newer), same ${c.same}`); if (c.differed.length) lines.push('  Different on both: ' + c.differed.slice(0, 15).join(', ') + (c.differed.length > 15 ? '…' : '')); }
    return lines.join('\n') + '\nNothing was deleted.';
  }
  function lastText() {
    const t = localStorage.getItem(LAST); if (!t) return 'Never backed up on this device.';
    const d = Math.floor((Date.now() - Date.parse(t)) / 864e5); return d < 1 ? 'Last backup: today.' : `Last backup: ${d} day${d > 1 ? 's' : ''} ago.`;
  }
  /** Adds the two big buttons into a container (the My sites sheet). */
  function mount(el) {
    el.innerHTML = `<div class="bk-box"><button type="button" class="big good" id="bkSave">💾 Back up everything</button>
      <label class="big bk-merge">📥 Merge from backup<input id="bkMerge" type="file" accept=".json,application/json" hidden></label>
      <p class="muted small-note" id="bkLast">${lastText()} One file with sites, layouts and My Jobs. Save it to Drive or email it to yourself; on another device use “Merge from backup”.</p></div>`;
    el.querySelector('#bkSave').onclick = async () => {
      try { const r = await backup(); if (r) { el.querySelector('#bkLast').firstChild.textContent = lastText(); (window.WellsSites || { toast: alert }).toast(`Backed up ${r.sites} sites, ${r.layouts} layouts, ${r.jobs} jobs`); } } catch (e) { alert('Backup failed: ' + (e.message || e)); }
    };
    el.querySelector('#bkMerge').onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return; e.target.value = '';
      try { const out = await merge(await f.text()); alert('Merge done.\n' + summary(out)); if (window.WellsSites && WellsSites.sheetMode === 'list') WellsSites.openList(); } catch (err) { alert('Merge failed: ' + (err.message || err)); }
    };
  }
  window.WellsBackup = { backup, merge, summary, mount, lastText };
})();
