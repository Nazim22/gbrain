#!/usr/bin/env python3
"""Stage-2 bounded retry plan for ONE attempt (canary.sh R; Pebble consult 2026-10-26 21:32Z).
   retry_plan.py <attempt-dir> <members.tsv> <kept-dir>      plan (R, before OPEN)
   retry_plan.py --outcome <attempt-dir>                       validate R's dream outcome (R, after CLOSE)
Eligible only when date_gates WITH the earlier-kept batches (<kept-dir>, the runbook's full gate context) fails on
complete evidence (exit 10) and EVERY failure is a malformed-output pair:
  - after.json state row fail_count >= 1, not tombstoned, no new atom and no live generation for the pair;
  - run.json lists exactly those sources as failures, each 'malformed model output ...';
  - date_gates' fails are exactly the two failed-pair messages per such pair, nothing else;
  - 1..MAX_RETRY pairs, each in this attempt's canary.manifest with the same content hash.
Then, in this order: retry.manifest is created EXCLUSIVELY (its existence consumes the attempt's single allowance, even if
anything later fails), retry.members (the matching member rows) and retry-snapshot.json (every OTHER pair's atoms,
live generations, items and state rows from the G-pass after.json, bound by sha256) are written.
Exit 0 = retry planned. Exit 1 = not eligible (nothing written). Exit 2 = evidence missing or unreadable.
--outcome: exit 0 prints the retry's failures (possibly []); exit 2 = missing, unreadable or incomplete = UNKNOWN outcome.
"""
import hashlib, json, os, subprocess, sys
MAX_RETRY = 5
HERE = os.path.dirname(os.path.abspath(__file__))
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()

def snapshot(after, paths):
    """The completed pairs' observable outcome: atoms, live generations + their items, state rows (date_gates reuses it)."""
    owner = {p['path']: p['ownerKey'] for p in after['pairs']}
    gens = [g for g in after['generations'] if g['state'] == 'live']
    out = {}
    for path in sorted(paths):
        g = sorted((x['id'], x['item_set_hash']) for x in gens if x['owner_key'] == owner[path])
        gid = {i for i, _ in g}
        out[path] = {
            'atoms': sorted([x['id'], x['content_hash'], x['deleted_at'], x['slug']] for x in after['atoms'] if x['pair'] == path),
            'live_generations': [list(t) for t in g],
            'items': sorted([i['generation_id'], i['item_key'], i['action'], bool(i['pending'])] for i in after['items'] if i['generation_id'] in gid),
            'state_rows': sorted([s['content_hash'], int(s['fail_count']), bool(s['tombstoned'])] for s in after['state_rows'] if s['file_path'] == path)}
    return out

def retry_outcome(path, retry_paths):
    """R's single dream outcome, structurally complete and final, or ValueError (= unknown outcome, STOP).
    Mirrors the real runs: one extract_atoms phase; processed + failures == admitted (G batch 01: 100+0, batch 02: 99+1)."""
    d = json.load(open(path))   # zero-byte / truncated / non-JSON raises
    ph = d.get('phases') if isinstance(d, dict) else None
    if not isinstance(d, dict) or d.get('schema_version') != 1 or not isinstance(ph, list) or len(ph) != 1 \
            or ph[0].get('phase') != 'extract_atoms' or not isinstance(ph[0].get('details'), dict):
        raise ValueError('retry outcome is not one extract_atoms phase of schema 1')
    det = ph[0]['details']
    ints = ('transcripts_processed', 'write_pending', 'held_failed', 'stopped_outputs')
    bools = ('dry_run', 'budget_exhausted', 'partial')
    if not isinstance(det.get('failures'), list) or any(type(det.get(k)) is not int for k in ints) or any(type(det.get(k)) is not bool for k in bools):
        raise ValueError('retry outcome lacks complete counters')
    if any(det[k] for k in bools) or any(det[k] for k in ints[1:]):
        raise ValueError(f"retry outcome is not final: {({k: det[k] for k in bools + ints[1:]})}")
    srcs = [f.get('source') for f in det['failures'] if isinstance(f, dict)]
    if len(srcs) != len(det['failures']) or any(s not in retry_paths for s in srcs):
        raise ValueError('retry outcome names a failure outside retry.manifest')
    if det['transcripts_processed'] + len(srcs) != len(retry_paths):
        raise ValueError(f"retry outcome accounts for {det['transcripts_processed']}+{len(srcs)} of {len(retry_paths)} retry pairs")
    return det['failures']

def failures_of(run):
    found = []
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == 'failures' and isinstance(v, list): found.extend(v)
                else: walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(run); return found

def main(a, members_tsv, kept_dir):
    if os.path.exists(f'{a}/retry.manifest'): print('REFUSE: the retry allowance of this attempt is used (retry.manifest exists)'); return 1
    if not os.path.isdir(kept_dir): raise FileNotFoundError(f'kept dir {kept_dir}')
    for f in ('run.json', 'before.json', 'after.json', 'plan.json', 'canary.manifest'):
        if not os.path.exists(f'{a}/{f}'): raise FileNotFoundError(f'{a}/{f}')
    man = [tuple(l.split('\t')) for l in open(f'{a}/canary.manifest').read().splitlines()]
    mem = [l.rstrip('\n').split('\t') for l in open(members_tsv) if l.strip()]
    if sorted(man) != sorted((r[0], r[3]) for r in mem): raise ValueError('members.tsv differs from canary.manifest')
    after = json.load(open(f'{a}/after.json')); run = json.load(open(f'{a}/run.json'))
    pair_hash = dict((p, h) for h, p in man)
    new_ids = set(json.load(open(f'{a}/plan.json'))['new_atom_ids'])
    atom_pairs = {x['pair'] for x in after['atoms'] if x['id'] in new_ids and not x['deleted_at']}
    owner = {p['path']: p['ownerKey'] for p in after['pairs']}
    live_owners = {g['owner_key'] for g in after['generations'] if g['state'] == 'live'}
    failed = sorted(s['file_path'] for s in after['state_rows'] if int(s['fail_count']) >= 1 and not s['tombstoned'])
    why = []
    for p in failed:
        row = [s for s in after['state_rows'] if s['file_path'] == p]
        if p not in pair_hash: why.append(f'{p}: failed row outside this manifest')
        elif any(s['content_hash'] != pair_hash[p] for s in row): why.append(f'{p}: failed row for a different content hash')
        elif p in atom_pairs or owner.get(p) in live_owners: why.append(f'{p}: failed row but atoms or a live generation exist')
    runf = failures_of(run)
    srcs = sorted(f.get('source') for f in runf)
    if srcs != failed: why.append(f'run.json failures {srcs} != failed state rows {failed}')
    bad = [f for f in runf if not str(f.get('error', '')).startswith('malformed model output')]
    if bad: why.append(f'non-malformed failures: {bad}')
    if not 1 <= len(failed) <= MAX_RETRY: why.append(f'{len(failed)} failed pairs (allowed 1..{MAX_RETRY})')
    # date_gates is the oracle: it must fail on complete evidence with exactly the failed-pair messages.
    g = subprocess.run([sys.executable, '-I', f'{HERE}/date_gates.py', a, members_tsv, kept_dir], capture_output=True, text=True)
    try: gate = json.loads(g.stdout[:g.stdout.rindex('}') + 1])
    except ValueError: gate = None
    want = sorted(m for p in failed for m in (f'{os.path.basename(p)}: failed state row', f'{os.path.basename(p)}: no atoms and no native zero-atom tombstone'))
    if g.returncode != 10 or gate is None: why.append(f'date_gates exit {g.returncode} (a retry needs exit 10)')
    elif gate['fail_count'] != len(gate['fails']) or sorted(gate['fails']) != want: why.append(f"date_gates fails are not only the failed pairs: {gate['fails']}")
    if why:
        print('REFUSE (not a bounded malformed-output retry; nothing written):'); [print('  ' + w) for w in why]; return 1
    rows = [(pair_hash[p], p) for h, p in man if p in failed]
    fd = os.open(f'{a}/retry.manifest', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)   # consumes the single allowance
    with os.fdopen(fd, 'w') as f: f.write(''.join(f'{h}\t{p}\n' for h, p in rows))
    with open(f'{a}/retry.members', 'x') as f: f.write(''.join('\t'.join(r) + '\n' for r in mem if r[3] in failed))
    others = [p for _, p in man if p not in failed]
    with open(f'{a}/retry-snapshot.json', 'x') as f:
        json.dump({'after_g1_sha256': sha(f'{a}/after.json'), 'plan_g1_sha256': sha(f'{a}/plan.json'), 'pairs': snapshot(after, others)}, f)
    print(json.dumps({'retry_pairs': len(rows), 'paths': [os.path.basename(p) for _, p in rows], 'preserved_pairs': len(others),
                      'retry_manifest_sha256': sha(f'{a}/retry.manifest')}, indent=1))
    return 0

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--outcome':
        a = sys.argv[2]
        try:
            paths = {l.split('\t')[1] for l in open(f'{a}/retry.manifest').read().splitlines()}
            print('retry failures:', json.dumps(retry_outcome(f'{a}/run-retry.json', paths))); sys.exit(0)
        except (OSError, ValueError, KeyError, IndexError) as e: print(f'STOP: unknown retry outcome: {type(e).__name__}: {e}'); sys.exit(2)
    if len(sys.argv) != 4: print(__doc__); sys.exit(2)
    try: sys.exit(main(*sys.argv[1:]))
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as e: print(f'STOP: evidence missing or unreadable: {type(e).__name__}: {e}'); sys.exit(2)
