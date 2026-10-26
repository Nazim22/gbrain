#!/usr/bin/env python3
"""Stage-2 gates for one attempt (STAGE2-DESIGN r3 §4; runbook step 'gates'). READ-ONLY: reads the attempt's files only.
   date_gates.py <attempt-dir> <members.tsv>
Reconciles the attempt-owned write set (canary.sh F/H captures + plan.json) against the frozen batch members:
  - bindings: before/after/plan bound to this canary.manifest; members.tsv == canary.manifest (hash16, dated path);
  - no existing atom changed; every new atom is live, belongs to a manifest pair, and no pair is outside the manifest;
  - each pair: atoms with exactly one live generation, OR a native zero-atom tombstone (and no failed state row);
  - no owner key with two live generations;
  - each new atom: source_hash/source_path = its pair, model provenance, frontmatter date = the part date at UTC
    midnight, effective_date_source 'date', effective_date on that day, slug folder = that day.
Exit 0 = PASS. Exit 10 = a gate failed on complete evidence. Exit 2 = evidence missing, unreadable or of the wrong
shape. The runbook treats EVERY nonzero exit as STOP; only a decision turns a 10 into a rollback.
"""
import hashlib, json, os, sys
from collections import Counter, defaultdict

def main(a, members_tsv):
    sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
    before, after, plan = (json.load(open(f'{a}/{f}')) for f in ('before.json', 'after.json', 'plan.json'))
    man = [l.split('\t') for l in open(f'{a}/canary.manifest').read().splitlines()]
    mem = [l.rstrip('\n').split('\t') for l in open(members_tsv) if l.strip()]
    if any(len(r) != 5 for r in mem): raise ValueError('members.tsv rows must have 5 fields')
    if before['manifest_sha256'] != sha(f'{a}/canary.manifest') or after['manifest_sha256'] != before['manifest_sha256']:
        raise ValueError('before/after are not bound to this canary.manifest')
    if sorted((h, p) for h, p in man) != sorted((r[0], r[3]) for r in mem): raise ValueError('members.tsv differs from canary.manifest')
    day = {r[3]: r[4] for r in mem}
    atoms = {x['id']: x for x in after['atoms']}
    for x in after['atoms']:
        if 'effective_date' not in x or 'effective_date_source' not in x: raise ValueError('after.json lacks effective_date fields (old capture)')
    fails = []
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
    failed = {s['file_path'] for s in after['state_rows'] if int(s['fail_count']) > 0}
    outcome = Counter()
    for p in after['pairs']:
        path, h = p['path'], p['hash16']; xs = by_pair.get(path, [])
        if path in failed: fails.append(f'{os.path.basename(path)}: failed state row')
        if xs:
            gens = [g for g in after['generations'] if g['owner_key'] == p['ownerKey'] and g['state'] == 'live']
            if len(gens) != 1: fails.append(f'{os.path.basename(path)}: {len(xs)} atoms, {len(gens)} live generations')
            outcome['atoms'] += 1
        elif (path, h) in tomb: outcome['zero-atom tombstone'] += 1
        else: fails.append(f'{os.path.basename(path)}: no atoms and no native zero-atom tombstone'); outcome['neither'] += 1
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
    return 10 if fails else 0

if __name__ == '__main__':
    if len(sys.argv) != 3: print(__doc__); sys.exit(2)
    try: rc = main(sys.argv[1], sys.argv[2])
    except Exception as e: print(f'STOP: gate evidence missing or unreadable: {type(e).__name__}: {e}'); sys.exit(2)
    print('GATES: PASS' if rc == 0 else 'GATES: FAIL (complete evidence) -> STOP; rollback only on a decision'); sys.exit(rc)
