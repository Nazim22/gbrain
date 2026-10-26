# date_gates.py on real canary attempt 2 data (read-only copies):
#  1. its 31 atoms as extracted (undated, the pre-patch capture plus null effective-date fields) -> exit 10, dates only;
#  2. the same with the dates the patch writes -> exit 0 (31 atoms in 16 pairs + 4 native tombstones);
#  3. evidence problems -> exit 2, never 10: after.json missing, a capture without effective-date fields,
#     members.tsv that differs from canary.manifest.
# Usage: python3 -I test_date_gates.py <attempt-dir> <missing-dates.tsv>
import json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); TOOL = os.path.join(HERE, 'date_gates.py')
src, dates_tsv = sys.argv[1], sys.argv[2]
day = {l.split('\t')[1]: l.rstrip('\n').split('\t')[2] for l in open(dates_tsv) if l.rstrip('\n').split('\t')[2]}
run = lambda a, m: subprocess.run([sys.executable, '-I', TOOL, a, m], capture_output=True, text=True)
with tempfile.TemporaryDirectory() as t:
    a = f'{t}/attempt'; os.makedirs(a)
    for f in ('before.json', 'after.json', 'plan.json', 'canary.manifest'): shutil.copy(f'{src}/{f}', a)
    pairs = [l.split('\t') for l in open(f'{a}/canary.manifest').read().splitlines()]
    mem = f'{t}/members.tsv'; open(mem, 'w').write(''.join(f'{h}\t-\t{p}\t{p}\t{day[p]}\n' for h, p in pairs))
    after = json.load(open(f'{a}/after.json'))

    r = run(a, mem); assert r.returncode == 2 and 'effective_date fields' in r.stdout, r   # 3b first: old capture shape
    for x in after['atoms']: x['effective_date'], x['effective_date_source'] = None, 'fallback'
    json.dump(after, open(f'{a}/after.json', 'w'))
    r = run(a, mem); out = json.loads(r.stdout[:r.stdout.rindex('}') + 1])
    assert r.returncode == 10 and out['fail_count'] == 2 * out['new_atoms'] == 62 and all(': date ' in f or 'slug folder' in f for f in out['fails']), r
    print(f"1. undated: exit 10 on dates only ({out['fail_count']} = 2 x {out['new_atoms']}), outcomes {out['outcomes']}")

    ids = set(json.load(open(f'{a}/plan.json'))['new_atom_ids'])
    for x in after['atoms']:
        if x['id'] in ids:
            d = day[x['frontmatter']['source_path']]
            x['frontmatter']['date'] = x['effective_date'] = f'{d}T00:00:00.000Z'; x['effective_date_source'] = 'date'
            x['slug'] = x['slug'].replace('atoms/undated/', f'atoms/{d}/')
    json.dump(after, open(f'{a}/after.json', 'w'))
    r = run(a, mem); out = json.loads(r.stdout[:r.stdout.rindex('}') + 1])
    assert r.returncode == 0 and out['outcomes'] == {'atoms': 16, 'zero-atom tombstone': 4} and 'GATES: PASS' in r.stdout, r
    print(f"2. dated: exit 0, outcomes {out['outcomes']}")

    bad = f'{t}/members-bad.tsv'; open(bad, 'w').write(open(mem).read().split('\n', 1)[1])   # one member short
    r = run(a, bad); assert r.returncode == 2 and 'differs from canary.manifest' in r.stdout, r
    good = json.load(open(f'{a}/after.json')); plan0 = json.load(open(f'{a}/plan.json'))
    def variant(after_obj, plan_obj, why):   # Pebble 18:33Z counterexamples: each must STOP (2), never PASS
        json.dump(after_obj, open(f'{a}/after.json', 'w')); json.dump(plan_obj, open(f'{a}/plan.json', 'w'))
        r = run(a, mem); assert r.returncode == 2 and why in r.stdout, (r.returncode, r.stdout[-300:])
    empty = dict(good, pairs=[], atoms=[], generations=[], state_rows=[])
    variant(empty, dict(plan0, new_atom_ids=[], changed_atom_ids=[]), 'pairs differ from canary.manifest')   # empty capture
    variant(dict(good, pairs=good['pairs'][1:]), plan0, 'pairs differ from canary.manifest')               # omitted pair
    variant(good, dict(plan0, new_atom_ids=plan0['new_atom_ids'][1:]), 'plan.json does not match')            # stale/omitted plan
    variant(good, dict(plan0, new_atom_ids=plan0['new_atom_ids'] + [999999999]), 'plan.json does not match')  # foreign id
    json.dump(good, open(f'{a}/after.json', 'w')); json.dump(plan0, open(f'{a}/plan.json', 'w'))
    r = run(a, mem); assert r.returncode == 0, r                                                              # restored: PASS again
    os.remove(f'{a}/after.json'); r = run(a, mem); assert r.returncode == 2 and 'STOP' in r.stdout, r
    print('3. evidence problems (old capture shape, members mismatch, empty capture, omitted pair, stale plan, foreign plan id, '
          'after.json missing): exit 2, never 10 or 0')
