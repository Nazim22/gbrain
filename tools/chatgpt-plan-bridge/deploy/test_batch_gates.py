# Gate test for batch.sh H (STAGE2-DESIGN r2 §4) on real canary attempt 2 data (read-only copies):
# 1. as captured, its 31 atoms are undated (pre-patch), so the date gates must fail on every one and nothing else fails;
# 2. with the dates the patch writes (frontmatter date, effective_date + source, slug folder), H must pass.
# Usage: python3 -I test_batch_gates.py <attempt-dir> <missing-dates.tsv>
import json, os, re, shutil, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
src, dates_tsv = sys.argv[1], sys.argv[2]
block = next(b for b in re.findall(r"<<'PY'\n(.*?)\nPY\n", open(f'{HERE}/batch.sh').read(), re.S) if 'fails = []' in b)
day = {l.split('\t')[1]: l.rstrip('\n').split('\t')[2] for l in open(dates_tsv) if l.rstrip('\n').split('\t')[2]}
with tempfile.TemporaryDirectory() as t:
    a, run = f'{t}/batch-01', f'{t}/run'; os.makedirs(a); os.makedirs(run)
    for f in ('before.json', 'after.json', 'plan.json', 'T_start'): shutil.copy(f'{src}/{f}', a)
    pairs = [l.split('\t') for l in open(f'{src}/canary.manifest').read().splitlines()]
    assert all(p in day for _, p in pairs), 'a canary part has no reproduced date'
    open(f'{a}/members.tsv', 'w').write(''.join(f'{h}\t-\t{p}\t{p}\t{day[p]}\n' for h, p in pairs))  # extracted under legacy names
    run_h = lambda: subprocess.run([sys.executable, '-I', '-c', block, a, open(f'{a}/T_start').read().strip(), run, '1'], capture_output=True, text=True)

    r = run_h(); out = json.loads(r.stdout)
    assert r.returncode == 10, r
    date_fails = [f for f in out['fails'] if ': date ' in f or 'slug folder' in f]
    assert out['fail_count'] == 2 * out['new_atoms'] and len(out['fails']) == min(20, out['fail_count']) and date_fails == out['fails'], out
    print(f"1. undated capture: FAIL on dates only ({out['fail_count']} = 2 x {out['new_atoms']} atoms), pairs {out['pairs']}, bridge {out['bridge_codes']}")

    after = json.load(open(f'{a}/after.json')); ids = set(json.load(open(f'{a}/plan.json'))['new_atom_ids'])
    for x in after['atoms']:
        if x['id'] in ids:
            d = day[x['frontmatter']['source_path']]
            x['frontmatter']['date'] = f'{d}T00:00:00.000Z'; x['effective_date'] = f'{d}T00:00:00.000Z'; x['effective_date_source'] = 'date'
            x['slug'] = x['slug'].replace('atoms/undated/', f'atoms/{d}/')
    json.dump(after, open(f'{a}/after.json', 'w'))
    r = run_h(); out = json.loads(r.stdout)
    assert r.returncode == 0 and out['fail_count'] == 0, r
    print(f"2. dated as the patch writes them: PASS ({out['new_atoms']} atoms, {out['pairs_with_atoms']} pairs with atoms)")
