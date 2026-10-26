"""Canary acceptance score for ONE rater (canary.sh S; DESIGN §8 r5) — the P8 metrics for a single arm, exact fractions:
cluster = (part, claim_key), GOOD only if every atom in it is supported and non-generic; cluster precision = good / clusters;
atom precision = supported-and-non-generic atoms / atoms. PASS needs BOTH >= 0.80.
Exit 0 PASS · 1 FAIL · 2 invalid labels (missing, duplicate or unknown id, bad enum/type, wrong part) — never scored.
Usage: score.py <key.json> <labels.jsonl>"""
import collections, json, sys
from fractions import Fraction
FIDELITY = {'supported', 'unsupported', 'contradicted', 'indeterminate'}; BAR = Fraction(4, 5)

def load(key, lines):
    labels = {}
    for n, l in enumerate(lines, 1):
        if not l.strip(): continue
        r = json.loads(l)
        if not isinstance(r, dict) or not isinstance(r.get('bid'), str): raise ValueError(f'line {n}: not a label object')
        b = r['bid']
        if b in labels: raise ValueError(f'duplicate label {b}')
        if b not in key: raise ValueError(f'unknown id {b}')
        if r.get('fidelity') not in FIDELITY: raise ValueError(f'{b}: fidelity {r.get("fidelity")!r}')
        if not isinstance(r.get('generic'), bool): raise ValueError(f'{b}: generic must be true/false')
        if not isinstance(r.get('claim_key'), str) or not r['claim_key']: raise ValueError(f'{b}: empty claim_key')
        if r.get('part') != key[b]['part']: raise ValueError(f'{b}: part {r.get("part")!r} != {key[b]["part"]}')
        labels[b] = r
    if set(labels) != set(key): raise ValueError(f'{len(set(key) - set(labels))} atom(s) unlabelled')
    return labels

def metrics(key, labels, gate=False):
    clusters, ok_atoms, n = collections.defaultdict(list), 0, 0
    for b, k in key.items():
        if gate and not k['verified']: continue
        ok = labels[b]['fidelity'] == 'supported' and not labels[b]['generic']
        clusters[(k['part'], labels[b]['claim_key'])].append(ok); ok_atoms += ok; n += 1
    good = sum(all(v) for v in clusters.values())
    return {'atoms': n, 'clusters': len(clusters), 'good': good,
            'cluster_prec': Fraction(good, len(clusters)) if clusters else None, 'atom_prec': Fraction(ok_atoms, n) if n else None}

def verdict(m): return m['cluster_prec'] is not None and m['cluster_prec'] >= BAR and m['atom_prec'] >= BAR

if __name__ == '__main__':
    key = json.load(open(sys.argv[1]))
    try: labels = load(key, open(sys.argv[2]).read().splitlines())
    except ValueError as e: print(f'INVALID: {e}'); sys.exit(2)
    f = lambda x: 'n/a' if x is None else f'{float(x):.3f} ({x.numerator}/{x.denominator})'
    m = metrics(key, labels); g = metrics(key, labels, gate=True); ok = verdict(m)
    print(f'atoms {m["atoms"]}  clusters {m["clusters"]}  good {m["good"]}  cluster_prec {f(m["cluster_prec"])}  atom_prec {f(m["atom_prec"])}  -> {"PASS" if ok else "FAIL"}')
    print(f'secondary, verified-quote atoms only: atoms {g["atoms"]}  cluster_prec {f(g["cluster_prec"])}  atom_prec {f(g["atom_prec"])}')
    print('fidelity', dict(collections.Counter(r['fidelity'] for r in labels.values())), 'generic', sum(r['generic'] for r in labels.values()))
    sys.exit(0 if ok else 1)
