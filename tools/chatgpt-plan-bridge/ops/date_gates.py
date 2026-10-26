#!/usr/bin/env python3
"""Stage-2 gates for one attempt (STAGE2-DESIGN r3 §4; runbook step 'gates'). READ-ONLY: reads the attempt's files only.
   date_gates.py <attempt-dir> <members.tsv> [<kept-dir>]
Reconciles the attempt-owned write set (canary.sh F/H captures + plan.json) against the frozen batch members:
  - bindings: before/after/plan bound to this canary.manifest; members.tsv == canary.manifest (hash16, dated path);
  - no existing atom changed; every new atom is live, belongs to a manifest pair, and no pair is outside the manifest;
  - each pair: atoms with exactly one live generation, OR a native zero-atom tombstone (and no failed state row);
  - no owner key with two live generations;
  - each new atom: source_hash/source_path = its pair, model provenance, frontmatter date = the part date at UTC
    midnight, effective_date_source 'date', effective_date on that day, slug folder = that day;
  - per pair, exactly one outcome: atoms whose single live generation has only published, non-pending items keyed to
    exactly those atom slugs and no tombstone, OR a native zero-atom tombstone with no live generation;
  - every member's file still has its frozen full sha256 (source stability at GATED);
  - [kept-dir] every earlier KEPT batch's atoms unchanged and live in the DB (read-only psql).
On PASS it writes <attempt>/gates.ok = sha256 of plan.json, after.json and members.tsv.
Exit 0 = PASS. Exit 10 = a gate failed on complete evidence. Exit 2 = evidence missing, unreadable or of the wrong
shape. The runbook treats EVERY nonzero exit as STOP; only a decision turns a 10 into a rollback.
"""
import hashlib, json, os, sys
from collections import Counter, defaultdict

def kept_check(kept_dir, fails):
    """Earlier KEPT batches (canary.sh resume records <kept_dir>/<attempt>.json = [{id, content_hash}]) must be
    unchanged in the DB: same ids, same content hashes, still live. Read-only psql (libpq env); a failed query raises."""
    import glob, subprocess
    for k in sorted(glob.glob(os.path.join(kept_dir, '*.json'))):
        kept = json.load(open(k)); ids = [int(r['id']) for r in kept]
        if not ids: continue
        out = subprocess.run(['psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c',
                              f"select id, content_hash, deleted_at is null from pages where id = any(array{ids}::bigint[]) order by id"],
                             capture_output=True, text=True, check=True).stdout
        now = [(int(i), c, v == 't') for i, c, v in (l.split('|') for l in out.splitlines())]
        want = sorted((int(r['id']), r['content_hash'], True) for r in kept)
        if now != want: fails.append(f'earlier kept batch changed: {os.path.basename(k)} ({len(set(want) ^ set(now))} differing rows)')

def main(a, members_tsv, kept_dir=None):
    sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
    before, after, plan = (json.load(open(f'{a}/{f}')) for f in ('before.json', 'after.json', 'plan.json'))
    man = [l.split('\t') for l in open(f'{a}/canary.manifest').read().splitlines()]
    mem = [l.rstrip('\n').split('\t') for l in open(members_tsv) if l.strip()]
    if any(len(r) != 5 for r in mem): raise ValueError('members.tsv rows must have 5 fields')
    if before['manifest_sha256'] != sha(f'{a}/canary.manifest') or after['manifest_sha256'] != before['manifest_sha256']:
        raise ValueError('before/after are not bound to this canary.manifest')
    if sorted((h, p) for h, p in man) != sorted((r[0], r[3]) for r in mem): raise ValueError('members.tsv differs from canary.manifest')
    day = {r[3]: r[4] for r in mem}
    # Completeness: both captures must carry exactly the manifest's pairs, or every per-pair check below is vacuous.
    want_pairs = sorted((h, p) for h, p in man)
    for name, cap in (('before', before), ('after', after)):
        if sorted((x['hash16'], x['path']) for x in cap['pairs']) != want_pairs:
            raise ValueError(f'{name}.json pairs differ from canary.manifest (capture incomplete or for another manifest)')
    # The plan is a claim: recompute it from the two captures (rollback-batch.ts writeSet: new = ids only in AFTER;
    # changed = same id, different page state over deleted_at, content_hash, frontmatter, compiled_truth).
    state = lambda x: json.dumps([x['deleted_at'], x['content_hash'], x['frontmatter'], x['compiled_truth']], sort_keys=True)
    b_atoms = {x['id']: x for x in before['atoms']}
    new_ids = sorted(x['id'] for x in after['atoms'] if x['id'] not in b_atoms)
    changed_ids = sorted(x['id'] for x in after['atoms'] if x['id'] in b_atoms and state(x) != state(b_atoms[x['id']]))
    if sorted(plan['new_atom_ids']) != new_ids or sorted(plan['changed_atom_ids']) != changed_ids:
        raise ValueError('plan.json does not match the captures (stale, omitted or foreign plan)')
    atoms = {x['id']: x for x in after['atoms']}
    for x in after['atoms']:
        if 'effective_date' not in x or 'effective_date_source' not in x: raise ValueError('after.json lacks effective_date fields (old capture)')
    fails = []
    # Source stability at GATED: every member's file still has the frozen full sha256 (a missing file is evidence trouble).
    for h, frozen, legacy, dated, d in mem:
        p = dated if os.path.exists(dated) else legacy
        if not os.path.exists(p): raise ValueError(f'member file missing: {legacy}')
        if sha(p) != frozen: fails.append(f'{os.path.basename(p)}: bytes changed since the freeze')
    if kept_dir: kept_check(kept_dir, fails)
    if plan['changed_atom_ids']: fails.append(f"existing atoms changed: {plan['changed_atom_ids'][:5]}")
    new = []
    for i in plan['new_atom_ids']:
        x = atoms.get(i)
        if x is None: raise ValueError(f'plan atom {i} missing from after.json')
        if x['deleted_at']: fails.append(f'new atom {i} is not live')
        elif x['pair'] not in day: fails.append(f'new atom {i} belongs to no manifest pair')
        else: new.append(x)
    live = Counter(g['owner_key'] for g in after['generations'] if g['state'] == 'live')
    if any(v > 1 for v in live.values()): fails.append(f'owner keys with several live generations: {[k for k, v in live.items() if v > 1][:5]}')
    by_pair = defaultdict(list)
    for x in new: by_pair[x['pair']].append(x)
    tomb = {(s['file_path'], s['content_hash']) for s in after['state_rows'] if s['tombstoned'] and int(s['fail_count']) == 0}
    any_tomb = {(s['file_path'], s['content_hash']) for s in after['state_rows'] if s['tombstoned']}
    failed = {s['file_path'] for s in after['state_rows'] if int(s['fail_count']) > 0}
    items = defaultdict(list)
    for it in after['items']: items[it['generation_id']].append(it)
    outcome = Counter()
    for p in after['pairs']:   # outcomes are mutually exclusive: atoms + exactly one consistent live generation, XOR a native tombstone
        path, h = p['path'], p['hash16']; xs = by_pair.get(path, []); name = os.path.basename(path)
        gens = [g for g in after['generations'] if g['owner_key'] == p['ownerKey'] and g['state'] == 'live']
        if path in failed: fails.append(f'{name}: failed state row')
        if xs:
            if len(gens) != 1: fails.append(f'{name}: {len(xs)} atoms, {len(gens)} live generations')
            else:
                its = items[gens[0]['id']]
                if any(it['pending'] or it['action'] != 'published' for it in its): fails.append(f'{name}: live generation has pending or unpublished items')
                if sorted(it['item_key'] for it in its) != sorted(x['slug'] for x in xs): fails.append(f'{name}: generation items differ from the atoms')
            if (path, h) in any_tomb: fails.append(f'{name}: atoms AND a tombstone')
            outcome['atoms'] += 1
        elif (path, h) in tomb:
            if gens: fails.append(f'{name}: zero-atom tombstone AND {len(gens)} live generation(s)')
            outcome['zero-atom tombstone'] += 1
        else: fails.append(f'{name}: no atoms and no native zero-atom tombstone'); outcome['neither'] += 1
        want = f'{day[path]}T00:00:00.000Z'
        for x in xs:
            fm = x['frontmatter']
            if fm.get('source_hash') != h or fm.get('source_path') != path: fails.append(f"atom {x['id']}: provenance")
            if not fm.get('extracted_model') or not fm.get('extracted_route'): fails.append(f"atom {x['id']}: no model provenance")
            if fm.get('date') != want or x['effective_date_source'] != 'date' or (x['effective_date'] or '')[:10] != day[path]:
                fails.append(f"atom {x['id']}: date {fm.get('date')} / {x['effective_date_source']} / {x['effective_date']} != {day[path]}")
            if x['slug'].split('/')[1] != day[path]: fails.append(f"atom {x['id']}: slug folder {x['slug']}")
    print(json.dumps({'pairs': len(after['pairs']), 'outcomes': dict(outcome), 'new_atoms': len(new),
                      'served_models': dict(Counter(x['frontmatter'].get('extracted_model') for x in new)),
                      'fail_count': len(fails), 'fails': fails[:20]}, indent=1))
    if fails: return 10
    # PASS receipt bound to the exact evidence; canary.sh (stage 2) S and resume require it to match.
    open(f'{a}/gates.ok', 'x').write(f"{sha(f'{a}/plan.json')} {sha(f'{a}/after.json')} {sha(members_tsv)}\n")   # invalidated at start
    return 0

if __name__ == '__main__':
    if len(sys.argv) not in (3, 4): print(__doc__); sys.exit(2)
    # Invalidate any earlier success FIRST: only a run that passes now may leave gates.ok behind (Pebble 19:30Z #1).
    try:
        if os.path.exists(os.path.join(sys.argv[1], 'gates.ok')): os.remove(os.path.join(sys.argv[1], 'gates.ok'))
    except OSError as e: print(f'STOP: cannot invalidate the previous gates.ok: {e}'); sys.exit(2)
    try: rc = main(*sys.argv[1:])
    except Exception as e: print(f'STOP: gate evidence missing or unreadable: {type(e).__name__}: {e}'); sys.exit(2)
    print('GATES: PASS' if rc == 0 else 'GATES: FAIL (complete evidence) -> STOP; rollback only on a decision'); sys.exit(rc)
