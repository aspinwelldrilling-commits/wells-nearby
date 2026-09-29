#!/usr/bin/env python3
"""Run the county-wide WCR extraction in spiral order (tools/spiral_plan.json), resumable, with verify-then-push batches.

  cd /workspace/wells-app && setsid nohup /workspace/.venv-pw/bin/python tools/spiral_run.py --push >> /workspace/wells-state/spiral.out 2>&1 < /dev/null &
  (log: /workspace/wells-state/spiral.log — outside the repo so it survives .cache loss / git clean)
  /workspace/.venv-pw/bin/python tools/spiral_run.py --status          # print progress / ETA, rewrite tools/spiral_plan.md
  options: --rings 1,2  --areas julian,alpine  --batch 150 (permits per commit)  --delay 2.5  --no-push-live-check

Per batch (default 150 permits, ~35 min at ~14 s/permit):
  extract_county_wcr.py --permits <batch> --area <id>  ->  headless phone check (tools/verify_wcr_area.py) of a sample of
  the new permits  ->  git commit + push  ->  wait until the live GitHub Pages manifest/tiles have the new permits and re-check a
  sample on the live site.  If the local check fails, nothing is pushed from then on (extraction continues; see log).
Resume: just start it again. Permits already in data/county-wcr/ are skipped; progress is derived from the cache files.
Polite: extract_county_wcr.py makes one county request at a time with --delay between; if a batch is mostly errors
(county servers down / throttling) the runner backs off 15 min and retries, and stops after 3 bad batches in a row.
Stop: kill -- -<pid> (process group; the current permit is redone on resume). Lock: /workspace/wells-state/spiral.lock
On start: preflight (OCR tools present — auto-installs tesseract with passwordless sudo if missing — else exit loudly),
regenerates the permit-location cache if it is gone, then a REPAIR phase re-runs permits whose result was an 'error'
(max 2 retries) or an old-version no_wcr caused by a tool/read failure, before continuing the spiral.
Sanity alarm: a batch (>= 30 permits) with a no_wcr rate above 75% (baseline ~40%) is not pushed and the run stops.
"""
import argparse, collections, datetime as dt, fcntl, json, os, random, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_county_wcr import tile_key  # noqa: E402  (same grid as the shards)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = '/workspace/.venv-pw/bin/python'
PLAN = os.path.join(ROOT, 'tools', 'spiral_plan.json')
PROG = os.path.join(ROOT, 'tools', 'spiral_progress.json')
MD = os.path.join(ROOT, 'tools', 'spiral_plan.md')
OUT = os.path.join(ROOT, 'data', 'county-wcr')
LIVE = 'https://aspinwelldrilling-commits.github.io/wells-nearby/'
GIT_ENV = dict(os.environ, GIT_AUTHOR_NAME='aspinwelldrilling-commits', GIT_COMMITTER_NAME='aspinwelldrilling-commits',
               GIT_AUTHOR_EMAIL='aspinwelldrilling-commits@users.noreply.github.com',
               GIT_COMMITTER_EMAIL='aspinwelldrilling-commits@users.noreply.github.com')
SEC_PER_PERMIT = 14.5  # measured on Ramona / Valley Center (delay 2.5 s)
RED = ('unreadable', 'partial', 'no_wcr')


STATE = os.environ.get('WELLS_STATE', '/workspace/wells-state')
LOGFILE = os.path.join(STATE, 'spiral.log')
NO_WCR_ALARM = 0.75   # baseline no_wcr share is ~40% (first 3,749 permits); a batch far above that means a broken pipeline
ALARM_MIN_N = 30


def log(*a):
    line = ' '.join([time.strftime('%Y-%m-%d %H:%M:%S')] + [str(x) for x in a])
    os.makedirs(STATE, exist_ok=True)
    with open(LOGFILE, 'a') as f: f.write(line + '\n')
    if sys.stdout.isatty(): print(line, flush=True)


def ensure_env():
    """Preflight: OCR/PDF tools (auto-install tesseract if possible) and the permit-location cache."""
    need = ['tesseract', 'pdftoppm', 'pdftotext', 'pdfimages', 'pdfinfo']
    import shutil
    if [t for t in need if not shutil.which(t)]:
        log('preflight: OCR/PDF tools missing — trying: sudo -n apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils')
        r = subprocess.run('sudo -n apt-get install -y -q tesseract-ocr tesseract-ocr-eng poppler-utils || (sudo -n apt-get update -q && sudo -n apt-get install -y -q tesseract-ocr tesseract-ocr-eng poppler-utils)',
                           shell=True, capture_output=True, text=True, timeout=1800)
        still = [t for t in need if not shutil.which(t)]
        if still:
            log(f'PREFLIGHT FAILED: still missing {still} (apt: {(r.stderr or r.stdout)[-300:]}) — not running'); sys.exit(4)
        log('preflight: installed OCR tools')
    canary()
    cache = os.path.join(STATE, 'all-permits.json')
    if not os.path.exists(cache):
        log('preflight: permit-location cache missing — downloading (paged county GIS query)')
        sys.path.insert(0, os.path.join(ROOT, 'tools'))
        import build_spiral_plan
        build_spiral_plan.download()
    log('preflight ok')


CANARY_PERMIT = 'DEH1977-LWELL-5873'   # 1977 "Water Well Drillers Report": must yield WCR pages via OCR


def canary():
    """End-to-end OCR self-test on a known county WCR (cached PDF in the state dir, downloaded once): the extractor's
    read_pdf must find >= 1 WCR page. Catches a broken tesseract/poppler/language pack or regex before any batch runs."""
    import tempfile, re as _re
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    import extract_county_wcr as X
    pdf = os.path.join(STATE, 'canary.pdf')
    if not os.path.exists(pdf):
        r = load_json(os.path.join(OUT, CANARY_PERMIT + '.json'), {}) or {}
        fid = _re.search(r'FileRecordId=(\d+)', (r.get('bestDocUrl') or '')).group(1)
        v = X.Viewer()
        try: data = v.fetch(fid)
        finally: v.close()
        open(pdf, 'wb').write(data)
    with tempfile.TemporaryDirectory() as tmp:
        pages = X.read_pdf(pdf, tmp)
    if not pages:
        log(f'CANARY FAILED: no WCR page read from {CANARY_PERMIT} ({pdf}) — OCR pipeline broken, not running'); sys.exit(4)
    log(f'canary ok: {len(pages)} WCR page(s) read from {CANARY_PERMIT}')


def chunk_permits(spec):
    """--chunk: comma list of permits, or a file (JSON list / {'permits': [...]} / one per line)."""
    if os.path.exists(spec):
        t = open(spec).read().strip()
        try:
            j = json.loads(t); return [x.upper() for x in (j['permits'] if isinstance(j, dict) else j)]
        except Exception:
            return [x.strip().upper() for x in t.split() if x.strip()]
    return [x.strip().upper() for x in spec.split(',') if x.strip()]


def repair_candidates(plan):
    """Permits to redo before the spiral continues: status 'error' (< 2 retries), or pre-v3 no_wcr/unreadable results
    that recorded a tool/read/viewer failure (these were misclassified before errors counted as errors)."""
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    from extract_county_wcr import HARD_ERROR, SCRIPT_VERSION
    out = []
    for ar in plan['areas']:
        for p in ar['permits']:
            r = load_json(os.path.join(OUT, p + '.json'), None)
            if not r: continue
            hard = any(HARD_ERROR.search(e) for e in r.get('errors', []))
            if (r.get('status') == 'error' and r.get('retries', 0) < 2) or \
               (r.get('version', 0) < SCRIPT_VERSION and hard and r.get('status') in ('no_wcr', 'unreadable', 'partial')):
                out.append((ar, p))
    return out


def load_json(p, default):
    try: return json.load(open(p))
    except Exception: return default


def status_of(permit):
    r = load_json(os.path.join(OUT, permit + '.json'), None)
    return r.get('status') if r else None


def area_counts(a):
    c = collections.Counter(status_of(p) or 'todo' for p in a['permits'])
    return dict(c)


def write_md(plan, prog):
    rows, tot = [], collections.Counter()
    for a in plan['areas']:
        c = area_counts(a); tot.update(c); pr = prog['areas'].get(a['id'], {})
        done = a['count'] - c.get('todo', 0)
        st = 'done' if done == a['count'] else ('in progress' if done else 'pending')
        live = pr.get('liveCount', 0)
        rows.append(f"| {a['order']} | {a['ring']} | {a['name']} (`{a['id']}`) | {a['distMi']} | {a['count']} | {done} | {c.get('readable', 0)} | "
                    f"{c.get('partial', 0)} | {c.get('unreadable', 0)} | {c.get('no_wcr', 0)} | {c.get('no_docs', 0) + c.get('error', 0) + c.get('destruction_wcr', 0)} | "
                    f"{st} | {live if live else '—'} |")
    todo = tot.get('todo', 0); hrs = todo * SEC_PER_PERMIT / 3600
    md = f"""# County WCR extraction — spiral plan & progress

Generated by `tools/spiral_run.py` ({dt.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %Z')}). Plan: `tools/spiral_plan.json`
(built by `tools/build_spiral_plan.py`: every non-destruction county DEH well permit — {plan['totalPermits']} — is assigned to the
nearest named area center; rings spiral outward from Ramona; within a ring, nearest first).

Remaining: **{todo} permits ≈ {hrs:.0f} h** at ~{SEC_PER_PERMIT:.0f} s/permit (one county request at a time, 2.5 s apart).

Run / resume (background, verify-then-push every 150 permits):

    cd /workspace/wells-app && setsid nohup /workspace/.venv-pw/bin/python tools/spiral_run.py --push >> /workspace/wells-state/spiral.out 2>&1 < /dev/null &
    tail -f /workspace/wells-state/spiral.log                        # progress log
    /workspace/.venv-pw/bin/python tools/spiral_run.py --status     # progress + ETA

"Live" = permits of the area confirmed in the live GitHub Pages shards (manifest hash + tile contents) after the last verified push.
"other" = no_docs + error + destruction report.

| # | Ring | Area | mi from Ramona | Permits | Processed | Readable | Partial | Unreadable | No WCR | Other | Status | Live |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
""" + '\n'.join(rows) + f"""
| | | **Total** | | {plan['totalPermits']} | {plan['totalPermits'] - todo} | {tot.get('readable', 0)} | {tot.get('partial', 0)} | {tot.get('unreadable', 0)} | {tot.get('no_wcr', 0)} | {tot.get('no_docs', 0) + tot.get('error', 0) + tot.get('destruction_wcr', 0)} | | |
"""
    open(MD, 'w').write(md)
    return todo, hrs


def save_prog(prog):
    json.dump(prog, open(PROG, 'w'), indent=1)


def git(*args, check=True):
    r = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, env=GIT_ENV)
    if check and r.returncode: raise RuntimeError(f'git {" ".join(args)}: {r.stderr.strip()[:300]}')
    return r.stdout.strip()


def push_commits():
    """Push local commits. This checkout is the only writer, so origin/main is normally an ancestor of HEAD and a plain
    push works even with someone's uncommitted edits in the tree. Otherwise rebase onto origin with --autostash."""
    git('fetch', '-q', 'origin')
    behind = subprocess.run(['git', 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'], cwd=ROOT).returncode != 0
    if behind:
        git('rebase', '-q', '--autostash', 'origin/main')
    git('push', '-q', 'origin', 'HEAD:main')


def sample(permits, k_read=4, k_red=5):
    by = collections.defaultdict(list)
    for p in permits: by[status_of(p)].append(p)
    random.shuffle(by['readable'])
    red = by['unreadable'] + by['partial'] + by['no_wcr']; random.shuffle(red)
    return by['readable'][:k_read] + red[:k_red]


def verify(permits, base=''):
    if not permits: return True, 'nothing to verify'
    cmd = [PY, os.path.join(ROOT, 'tools', 'verify_wcr_area.py'), ','.join(permits)] + (['--base', base] if base else [])
    for attempt in (1, 2):
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=1800)
        out = (r.stdout + r.stderr).strip()
        for line in out.splitlines(): log('   verify:', line)
        if r.returncode == 0: return True, out.splitlines()[-1] if out else ''
        time.sleep(60)
    return False, out[-500:]


def wait_live(permits, timeout=1200):
    """True once the live manifest lists, for every tile holding one of these permits, the same content hash as the local
    manifest, and the live tiles actually contain the permits."""
    man = load_json(os.path.join(OUT, 'manifest.json'), {}).get('tiles', {})
    keys = {}
    for p in permits:
        r = load_json(os.path.join(OUT, p + '.json'), {})
        if r.get('lat') is not None: keys.setdefault(tile_key(r['lat'], r['lon']), []).append(p)
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            get = lambda u: json.load(urllib.request.urlopen(urllib.request.Request(LIVE + u, headers={'Cache-Control': 'no-cache'}), timeout=60))
            live = get(f'data/county-wcr/manifest.json?ts={int(time.time())}').get('tiles', {})
            stale = [k for k in keys if (live.get(k) or {}).get('h') != (man.get(k) or {}).get('h')]
            if not stale:
                missing = [p for k, ps in keys.items() for p in ps if p not in get(f'data/county-wcr/tiles/{k}.json?v={man[k]["h"]}').get('permits', {})]
                if not missing: return True, sum(t['n'] for t in live.values())
                log('   live tiles missing permits:', missing[:5])
        except Exception as e:
            log('   live check error', str(e)[:120])
        time.sleep(45)
    return False, 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rings', default=''); ap.add_argument('--areas', default=''); ap.add_argument('--batch', type=int, default=150)
    ap.add_argument('--delay', type=float, default=2.5); ap.add_argument('--push', action='store_true')
    ap.add_argument('--no-push-live-check', action='store_true'); ap.add_argument('--status', action='store_true')
    ap.add_argument('--chunk', default='', help='run ONLY these permits (list or file) with --force, grouped by plan area, then exit')
    ap.add_argument('--label', default='chunk', help='commit/log label for --chunk')
    ap.add_argument('--alarm', type=float, default=NO_WCR_ALARM, help='no_wcr share that stops the run (rechecks of no_wcr records expect a high share)')
    a = ap.parse_args()
    plan = load_json(PLAN, None); prog = load_json(PROG, {'areas': {}})
    if a.status:
        todo, hrs = write_md(plan, prog)
        for ar in plan['areas']:
            c = area_counts(ar); print(f"{ar['order']:>2} r{ar['ring']} {ar['id']:<20} {ar['count'] - c.get('todo', 0):>5}/{ar['count']:<5} {c}")
        print(f'remaining {todo} permits ≈ {hrs:.1f} h'); return
    os.makedirs(STATE, exist_ok=True)
    lock = open(os.path.join(STATE, 'spiral.lock'), 'w')
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError: log('another spiral_run is already running (wells-state/spiral.lock) — exiting'); sys.exit(1)
    lock.write(str(os.getpid())); lock.flush()
    ensure_env()
    rings = {int(x) for x in a.rings.split(',') if x.strip()}; only = {x.strip() for x in a.areas.split(',') if x.strip()}
    areas = [ar for ar in plan['areas'] if (not rings or ar['ring'] in rings) and (not only or ar['id'] in only)]
    S = {'push_ok': a.push, 'bad_streak': 0}
    log(f'spiral run pid {os.getpid()}: {len(areas)} areas, push={a.push}, batch={a.batch}, delay={a.delay}')

    def run_batch(ar, batch, force=False, label=''):
        """Extract one batch, sanity-check, verify, commit, push, live-check. Returns False to retry the same work later."""
        pr = prog['areas'].setdefault(ar.get('progKey', ar['id']), {'batches': []})
        log(f"{ar['id']} (ring {ar['ring']}){label}: batch of {len(batch)}" + (' (redo, --force)' if force else ''))
        t0 = time.time()
        before = {p: (load_json(os.path.join(OUT, p + '.json'), {}) or {}).get('processed') for p in batch} if force else {}
        cmd = [PY, os.path.join(ROOT, 'tools', 'extract_county_wcr.py'), '--permits', ','.join(batch), '--area', ar['id'], '--delay', str(a.delay)] + (['--force'] if force else [])
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        for line in (r.stdout + r.stderr).strip().splitlines()[-3:]: log('   extract:', line)
        if force:
            done = [p for p in batch if (load_json(os.path.join(OUT, p + '.json'), {}) or {}).get('processed') not in (None, before.get(p))]
        else:
            done = [p for p in batch if status_of(p)]
        c = collections.Counter(status_of(p) for p in done)
        secs = (time.time() - t0) / max(1, len(done))
        log(f"   batch done: {len(done)}/{len(batch)} {dict(c)} {secs:.1f} s/permit")
        if r.returncode == 4:
            log('   extractor PREFLIGHT failed (OCR tools missing) — stopping'); sys.exit(4)
        if r.returncode != 0 and not done:
            log('   extractor failed with nothing done — stopping'); sys.exit(2)
        if len(done) >= 10 and c.get("error", 0) > 0.5 * len(done):
            S['bad_streak'] += 1
            log(f'   mostly errors (county servers?) — backing off 15 min (streak {S["bad_streak"]})')
            if S['bad_streak'] >= 3: log('   3 bad batches in a row — stopping; resume later'); sys.exit(3)
            time.sleep(900); return False
        S['bad_streak'] = 0
        if len(done) >= ALARM_MIN_N and c.get('no_wcr', 0) / len(done) > a.alarm:
            S['push_ok'] = False
            log(f"   ALARM: no_wcr {c.get('no_wcr', 0)}/{len(done)} = {c.get('no_wcr', 0) / len(done):.0%} (baseline ~40%, limit {a.alarm:.0%}) — "
                'NOT pushing and stopping. Check tools (tesseract), the viewer and a few permits by hand; results stay uncommitted.')
            write_md(plan, prog); sys.exit(5)
        entry = {'at': dt.datetime.now().astimezone().isoformat(timespec='seconds'), 'n': len(done), 'counts': dict(c), 'secPerPermit': round(secs, 1)}
        if force: entry['redo'] = True
        write_md(plan, prog)
        if S['push_ok']:
            smp = sample(done)
            ok, msg = verify(smp)
            if not ok:  # one fresh sample before giving up (a grouped-marker popup occasionally misses)
                smp = sample(done); ok, msg = verify(smp)
            entry['verified'] = ok
            if not ok:
                log('   LOCAL VERIFICATION FAILED — pushing disabled for the rest of this run:', msg)
                S['push_ok'] = False
            else:
                total = len(ar['permits']) - area_counts(ar).get('todo', 0)
                save_prog(prog); write_md(plan, prog)
                git('add', 'data/county-wcr', 'tools/spiral_progress.json', 'tools/spiral_plan.md')
                what = f"redo {len(done)}" if force else f"+{len(done)}, {total}/{ar['count']}"
                git('commit', '-q', '-m', f"WCR cache: {ar['name']} ({what}) {dict(c)}")
                try:
                    push_commits()
                    entry['commit'] = git('rev-parse', '--short', 'HEAD'); log('   pushed', entry['commit'])
                    if not a.no_push_live_check:
                        live, n = wait_live(done)
                        entry['live'] = live
                        if live:
                            pr['liveCount'] = total
                            okl, msgl = verify(smp[:3], LIVE)
                            entry['liveVerified'] = okl
                            log(f'   live: shards have {n} permits; live app check: {"ok" if okl else "FAILED " + msgl[-200:]}')
                        else:
                            log('   live site did not show the new permits within 20 min')
                except Exception as e:
                    log('   push failed (will retry with the next batch):', str(e)[:300])
        pr['batches'].append(entry); save_prog(prog); write_md(plan, prog)
        return True

    if a.chunk:  # one small, checkable chunk: these permits only, then stop
        want = list(dict.fromkeys(chunk_permits(a.chunk)))
        # one pseudo-area: --area '' keeps each permit's own area in its record; progress logged under 'chunk:<label>'
        ar = {'id': '', 'progKey': 'chunk:' + a.label, 'name': a.label, 'ring': -1, 'permits': want, 'count': len(want)}
        log(f"CHUNK {a.label}: {len(want)} permits")
        k = 0
        while k < len(want):
            if run_batch(ar, want[k:k + a.batch], force=True, label=f' {a.label}'): k += a.batch
        write_md(plan, prog); save_prog(prog)
        log(f'CHUNK {a.label} finished'); return
    # 1) repair phase: misclassified / errored permits first
    rep = repair_candidates(plan)
    if rep:
        log(f'REPAIR: {len(rep)} permits to redo ' + str(dict(collections.Counter(ar["id"] for ar, p in rep))))
    by_area = collections.OrderedDict()
    for ar, p in rep: by_area.setdefault(ar['id'], (ar, []))[1].append(p)
    for ar, ps in by_area.values():
        k = 0
        while k < len(ps):
            if run_batch(ar, ps[k:k + a.batch], force=True, label=' REPAIR'): k += a.batch
    # 2) spiral
    for ar in areas:
        retried = False
        while True:
            todo = [p for p in ar['permits'] if status_of(p) is None]
            if not todo:
                errs = [p for p in ar['permits'] if status_of(p) == 'error' and (load_json(os.path.join(OUT, p + '.json'), {}) or {}).get('retries', 0) < 2]
                if errs and not retried:
                    retried = True
                    log(f"{ar['id']}: retrying {len(errs)} errored permits")
                    for k in range(0, len(errs), a.batch): run_batch(ar, errs[k:k + a.batch], force=True, label=' retry')
                    continue
                log(f"{ar['id']}: complete {area_counts(ar)}"); break
            log(f"{ar['id']}: {len(todo)} to do")
            run_batch(ar, todo[:a.batch])
    todo, hrs = write_md(plan, prog); save_prog(prog)
    log(f'run finished; remaining {todo} permits (~{hrs:.1f} h)')


if __name__ == '__main__':
    main()
