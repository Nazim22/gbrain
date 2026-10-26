# date_gates.py on real canary attempt 2 data (read-only copies; the kept check reads the live DB read-only):
#  1. its 31 atoms as extracted (undated, null effective-date fields) -> exit 10, dates only;
#  2. the same with the dates the patch writes -> exit 0, writes gates.ok bound to plan/after/members;
#  3. gate failures on complete evidence -> exit 10: a member's bytes changed, a tombstone pair with a live generation,
#     generation items that differ from the atoms, an earlier kept batch changed in the DB;
#  4. evidence problems -> exit 2, never 0 or 10: old capture shape, members mismatch, empty capture, omitted pair,
#     stale plan, foreign plan id, after.json missing.
# Usage: python3 -I test_date_gates.py <attempt-dir> <missing-dates.tsv>
import copy, hashlib, json, os, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); TOOL = os.path.join(HERE, 'date_gates.py')
src, dates_tsv = sys.argv[1], sys.argv[2]
day = {l.split('\t')[1]: l.rstrip('\n').split('\t')[2] for l in open(dates_tsv) if l.rstrip('\n').split('\t')[2]}
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
with tempfile.TemporaryDirectory() as t:
    a, kept = f'{t}/attempt', f'{t}/kept'; os.makedirs(a); os.makedirs(kept)
    for f in ('before.json', 'after.json', 'plan.json', 'canary.manifest'): shutil.copy(f'{src}/{f}', a)
    pairs = [l.split('\t') for l in open(f'{a}/canary.manifest').read().splitlines()]
    mem = f'{t}/members.tsv'; open(mem, 'w').write(''.join(f'{h}\t{sha(p)}\t{p}\t{p}\t{day[p]}\n' for h, p in pairs))
    run = lambda m=mem, k=None: subprocess.run([sys.executable, '-I', TOOL, a, m] + ([k] if k else []), capture_output=True, text=True)
    out_of = lambda r: json.loads(r.stdout[:r.stdout.rindex('}') + 1])
    def put(after_obj, plan_obj=None):
        json.dump(after_obj, open(f'{a}/after.json', 'w'))
        if plan_obj is not None: json.dump(plan_obj, open(f'{a}/plan.json', 'w'))
        if os.path.exists(f'{a}/gates.ok'): os.remove(f'{a}/gates.ok')
    after = json.load(open(f'{a}/after.json')); plan0 = json.load(open(f'{a}/plan.json'))

    r = run(); assert r.returncode == 2 and 'effective_date fields' in r.stdout, r            # old capture shape
    for x in after['atoms']: x['effective_date'], x['effective_date_source'] = None, 'fallback'
    put(after); r = run(); out = out_of(r)
    assert r.returncode == 10 and out['fail_count'] == 62 and all(': date ' in f or 'slug folder' in f for f in out['fails']), r
    print(f"1. undated: exit 10 on dates only ({out['fail_count']} = 2 x {out['new_atoms']}), outcomes {out['outcomes']}")

    ids = set(plan0['new_atom_ids']); slug_of = {}
    for x in after['atoms']:
        if x['id'] in ids:
            d = day[x['frontmatter']['source_path']]; old = x['slug']
            x['frontmatter']['date'] = x['effective_date'] = f'{d}T00:00:00.000Z'; x['effective_date_source'] = 'date'
            x['slug'] = old.replace('atoms/undated/', f'atoms/{d}/'); slug_of[old] = x['slug']
    for it in after['items']: it['item_key'] = slug_of.get(it['item_key'], it['item_key'])   # items follow the dated slugs
    good = copy.deepcopy(after); put(good)
    k1 = f'{kept}/attempt-x.json'; json.dump([{'id': x['id'], 'content_hash': x['content_hash']} for x in json.load(open(f'{src}/after.json'))['atoms'] if x['id'] in ids][:5], open(k1, 'w'))
    r = run(k=kept); out = out_of(r)
    assert r.returncode == 0 and out['outcomes'] == {'atoms': 16, 'zero-atom tombstone': 4} and 'GATES: PASS' in r.stdout, r
    want_ok = f"{sha(f'{a}/plan.json')} {sha(f'{a}/after.json')} {sha(mem)}\n"
    assert open(f'{a}/gates.ok').read() == want_ok
    print(f"2. dated: exit 0, outcomes {out['outcomes']}, earlier kept batch verified in the DB, gates.ok bound")

    # Stale success (Pebble 19:30Z #1): after a PASS, a failing or unknown rerun must remove gates.ok. The marker is
    # NOT deleted by the harness here; date_gates itself must invalidate it.
    assert os.path.exists(f'{a}/gates.ok')
    json.dump([{'id': json.load(open(k1))[0]['id'], 'content_hash': '0' * 64}], open(f'{kept}/attempt-z.json', 'w'))
    r = run(k=kept); assert r.returncode == 10 and not os.path.exists(f'{a}/gates.ok'), ('PASS->FAIL left gates.ok', r)
    os.remove(f'{kept}/attempt-z.json'); r = run(k=kept); assert r.returncode == 0 and os.path.exists(f'{a}/gates.ok'), r
    os.rename(f'{a}/plan.json', f'{a}/plan.json.away'); r = run(k=kept)
    assert r.returncode == 2 and not os.path.exists(f'{a}/gates.ok'), ('PASS->unknown left gates.ok', r)
    os.rename(f'{a}/plan.json.away', f'{a}/plan.json')
    print('2b. stale success: PASS -> FAIL and PASS -> unknown both remove gates.ok (marker not touched by the harness)')
    m2 = f'{t}/members-changed.tsv'; open(m2, 'w').write(open(mem).read().replace(sha(pairs[0][1]), '0' * 64, 1))
    r = run(m=m2); assert r.returncode == 10 and 'bytes changed since the freeze' in r.stdout, r
    bad = copy.deepcopy(good); tp = next(p for p in bad['pairs'] if any(s['file_path'] == p['path'] and s['tombstoned'] for s in bad['state_rows']))
    bad['generations'].append({'id': 999999, 'owner_key': tp['ownerKey'], 'generation': 1, 'state': 'live', 'run_id': None, 'input_pin': None, 'item_set_hash': None})
    put(bad); r = run(); assert r.returncode == 10 and 'zero-atom tombstone AND 1 live generation' in r.stdout, r
    bad = copy.deepcopy(good); bad['items'] = bad['items'][1:]; put(bad)
    r = run(); assert r.returncode == 10 and 'generation items differ from the atoms' in r.stdout, r
    json.dump([{'id': json.load(open(k1))[0]['id'], 'content_hash': '0' * 64}], open(f'{kept}/attempt-y.json', 'w')); put(good)
    r = run(k=kept); assert r.returncode == 10 and 'earlier kept batch changed: attempt-y.json' in r.stdout, r
    os.remove(f'{kept}/attempt-y.json')
    print('3. complete-evidence failures (bytes changed, tombstone+generation, items != atoms, kept batch changed): exit 10')

    bad = f'{t}/members-bad.tsv'; open(bad, 'w').write(open(mem).read().split('\n', 1)[1])
    r = run(m=bad); assert r.returncode == 2 and 'differs from canary.manifest' in r.stdout, r
    def variant(after_obj, plan_obj, why):
        put(after_obj, plan_obj); r = run(); assert r.returncode == 2 and why in r.stdout, (r.returncode, r.stdout[-300:])
    variant(dict(good, pairs=[], atoms=[], generations=[], items=[], state_rows=[]), dict(plan0, new_atom_ids=[], changed_atom_ids=[]), 'pairs differ from canary.manifest')
    variant(dict(good, pairs=good['pairs'][1:]), plan0, 'pairs differ from canary.manifest')
    variant(good, dict(plan0, new_atom_ids=plan0['new_atom_ids'][1:]), 'plan.json does not match')
    variant(good, dict(plan0, new_atom_ids=plan0['new_atom_ids'] + [999999999]), 'plan.json does not match')
    put(good, plan0); r = run(); assert r.returncode == 0, r                                     # restored: PASS again
    os.remove(f'{a}/after.json'); r = run(); assert r.returncode == 2 and 'STOP' in r.stdout, r
    print('4. evidence problems (old shape, members mismatch, empty capture, omitted pair, stale/foreign plan, after.json missing): exit 2')
