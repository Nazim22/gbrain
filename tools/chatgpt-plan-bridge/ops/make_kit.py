"""Blind labelling kit for a canary attempt (canary.sh K; DESIGN §8 r5): EVERY atom in the attempt's write set
(plan.json new_atom_ids + changed_atom_ids, content from after.json), grouped per source part in manifest order, under random
8-hex ids. Per part: the exact source bytes (hash16 re-checked against the manifest), then its atoms shuffled. Model, route and
quote-verification stay in rating/key.json, which raters never open. LABEL-BRIEF + CALIBRATION are copied hash-pinned.
Reconciles exactly: plan ids == kit atoms == key rows. Titles come from pages.title (read-only; libpq env from canary.sh).
Usage: make_kit.py <attempt_dir>"""
import hashlib, json, os, random, shutil, subprocess, sys
A = sys.argv[1]; R = f'{A}/rating'
PINS = {'LABEL-BRIEF.md': 'bc1448bbb56edd00fa777d33332784912b3f4951a97410a056d387b2de00680e',
        'CALIBRATION.md': '1996e67355d3b8f3e03b2a5597fb5770abea553660e8e81a805c78b9cc15688b'}
BRIEF_DIR = '/root/work/dream-s551/extract-bakeoff'
sha = lambda b: hashlib.sha256(b).hexdigest()
plan = json.load(open(f'{A}/plan.json')); after = json.load(open(f'{A}/after.json'))
ids = [int(i) for i in plan['new_atom_ids'] + plan['changed_atom_ids']]
assert len(ids) == len(set(ids)), 'duplicate atom id in plan'
atoms = {int(a['id']): a for a in after['atoms']}
missing = [i for i in ids if i not in atoms]; assert not missing, f'plan ids absent from after.json: {missing}'
manifest = [l.split('\t') for l in open(f'{A}/canary.manifest').read().splitlines() if l]
order = {p: (i, h) for i, (h, p) in enumerate(manifest)}
off = [i for i in ids if atoms[i]['pair'] not in order]; assert not off, f'atoms whose source is outside the manifest: {off}'
titles = dict(l.split('\t', 1) for l in subprocess.run(
    ['psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-F', '\t', '-c', f"select id, title from pages where id in ({','.join(map(str, ids))})"],
    check=True, capture_output=True, text=True).stdout.splitlines()) if ids else {}
assert len(titles) == len(ids), f'titles found for {len(titles)} of {len(ids)} atoms'
os.makedirs(f'{R}/kit')   # no clobber: one kit per attempt
for f, want in PINS.items():
    shutil.copyfile(f'{BRIEF_DIR}/{f}', f'{R}/kit/{f}'); assert sha(open(f'{R}/kit/{f}', 'rb').read()) == want, f'{f} hash'
rng = random.Random(55220261026); key = {}
parts = sorted({atoms[i]['pair'] for i in ids}, key=lambda p: order[p][0])
for n, path in enumerate(parts, 1):
    raw = open(path, 'rb').read(); assert sha(raw)[:16] == order[path][1], f'source changed since the manifest: {path}'
    mine = [atoms[i] for i in ids if atoms[i]['pair'] == path]; rng.shuffle(mine)
    out = [f'# Part {n:02d} — c{n:02d}\n', '## Source (the exact input file)\n```\n' + raw.decode('utf-8', errors='replace') + '\n```\n',
           f'## Atoms to label ({len(mine)})\n']
    for a in mine:
        fm = a['frontmatter']; bid = sha(f'{a["id"]}:{rng.random()}'.encode())[:8]; assert bid not in key, 'bid collision'
        key[bid] = {'atom_id': a['id'], 'part': f'part-{n:02d}', 'path': path, 'verified': bool(fm.get('source_quote_verified')),
                    'model': fm.get('extracted_model'), 'route': fm.get('extracted_route')}
        out.append(f'### atom {bid}\n- title: {titles[str(a["id"])]}\n- body: {a["compiled_truth"].strip()}\n- lesson: {fm.get("lesson")}\n'
                   f'- quote offered: {fm.get("source_quote") or ""}\n')
    open(f'{R}/kit/part-{n:02d}.md', 'w').write('\n'.join(out))
json.dump(key, open(f'{R}/key.json', 'w'), indent=1)
assert sorted(k['atom_id'] for k in key.values()) == sorted(ids), 'kit does not reconcile with the plan'
per = {p: sum(k['part'] == p for k in key.values()) for p in sorted({k['part'] for k in key.values()})}
print(json.dumps({'plan_atom_ids': len(ids), 'kit_atoms': len(key), 'parts_with_atoms': len(parts), 'manifest_parts': len(manifest), 'per_part': per}))
for f in sorted(os.listdir(f'{R}/kit')): print(sha(open(f'{R}/kit/{f}', 'rb').read()), f'kit/{f}')
