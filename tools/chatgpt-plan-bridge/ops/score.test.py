"""score.py: threshold boundaries, both metrics, and every invalid-label class (exit 2, never scored). Usage: python3 -I score.test.py"""
import json, os, subprocess, sys, tempfile
S = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py'); fails = 0

def run(n_atoms, bad=(), clusters=None, generic=(), mutate=None, verified=None, corrupt_key=False):
    """n_atoms atoms in part-01; `bad` indexes unsupported; clusters[i] = claim key of atom i (default: one cluster each)."""
    with tempfile.TemporaryDirectory() as t:
        key = {f'{i:08x}': {'atom_id': i, 'part': 'part-01', 'verified': True if verified is None else i in verified} for i in range(n_atoms)}
        rows = [{'bid': b, 'part': 'part-01', 'fidelity': 'unsupported' if i in bad else 'supported', 'generic': i in generic,
                 'claim_key': (clusters or {}).get(i, f'c{i}'), 'evidence': '', 'reason': 'synthetic'} for i, b in enumerate(key)]
        lines = [json.dumps(r) for r in rows]
        if mutate: lines = mutate(lines)
        json.dump(key, open(f'{t}/key.json', 'w')); open(f'{t}/l.jsonl', 'w').write('\n'.join(lines) + '\n')
        if corrupt_key: open(f'{t}/key.json', 'w').write('{not json')
        return subprocess.run([sys.executable, '-I', S, f'{t}/key.json', f'{t}/l.jsonl'], capture_output=True, text=True).returncode

def expect(name, got, want):
    global fails
    print(('OK   ' if got == want else 'FAIL ') + f'{name} (exit {got}, want {want})'); fails += got != want

expect('all supported -> PASS', run(10), 0)
expect('exactly 0.80 (8/10) -> PASS', run(10, bad={0, 1}), 0)
expect('just under (15/19 = 0.789) -> FAIL', run(19, bad={0, 1, 2, 3}), 10)
expect('atom 0.80 but cluster 0.60 -> FAIL', run(10, bad={0, 2}, clusters={i: f'k{i // 2}' for i in range(10)}), 10)
expect('cluster 0.875 but atom 0.70 -> FAIL', run(10, bad={0, 1, 2}, clusters={0: 'k', 1: 'k', 2: 'k'}), 10)
expect('generic counts as not good (2 generic of 10 -> 0.80 PASS)', run(10, generic={0, 1}), 0)
expect('3 generic of 10 -> FAIL', run(10, generic={0, 1, 2}), 10)
expect('zero atoms -> FAIL', run(0), 10)
expect('missing label -> INVALID', run(10, mutate=lambda l: l[:-1]), 2)
expect('duplicate label -> INVALID', run(10, mutate=lambda l: l + [l[0]]), 2)
expect('unknown id -> INVALID', run(10, mutate=lambda l: l + [json.dumps({**json.loads(l[0]), 'bid': 'ffffffff'})]), 2)
expect('bad fidelity enum -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'fidelity': 'mostly'})] + l[1:]), 2)
expect('generic as a string -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'generic': 'false'})] + l[1:]), 2)
expect('empty claim_key -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'claim_key': ''})] + l[1:]), 2)
expect('wrong part -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'part': 'part-02'})] + l[1:]), 2)
expect('malformed JSON line -> INVALID', run(10, mutate=lambda l: l + ['{not json']), 2)
expect('verified-quote gate is secondary only (PASS unchanged)', run(10, bad={0, 1}, verified={2, 3}), 0)
expect('fidelity as a list (unhashable) -> INVALID, not a crash', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'fidelity': []})] + l[1:]), 2)
expect('fidelity as a dict -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'fidelity': {}})] + l[1:]), 2)
expect('generic null -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'generic': None})] + l[1:]), 2)
expect('missing evidence -> INVALID', run(10, mutate=lambda l: [json.dumps({k: v for k, v in json.loads(l[0]).items() if k != 'evidence'})] + l[1:]), 2)
expect('missing reason -> INVALID', run(10, mutate=lambda l: [json.dumps({k: v for k, v in json.loads(l[0]).items() if k != 'reason'})] + l[1:]), 2)
expect('blank reason -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'reason': '  '})] + l[1:]), 2)
expect('extra key -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'score': 1})] + l[1:]), 2)
expect('evidence over 200 chars -> INVALID', run(10, mutate=lambda l: [json.dumps({**json.loads(l[0]), 'evidence': 'x' * 201})] + l[1:]), 2)
expect('a JSON array line -> INVALID', run(10, mutate=lambda l: l + ['[1]']), 2)
expect('unreadable key file -> ERROR 3, never a score', run(10, mutate=lambda l: l, corrupt_key=True), 3)
print(f'RESULT: {fails} failure(s)'); sys.exit(fails)
