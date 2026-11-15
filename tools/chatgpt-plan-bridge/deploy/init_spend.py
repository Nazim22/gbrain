"""First-paid initialisation of the bridge counters (GBRAIN-S593, PAID-RUNBOOK.md). Run as the bridge user with every
bridge process stopped. Adds "spend": {} to an EXISTING, VALID plan-mode counters file and changes nothing else.
Fail closed: a missing, unreadable, linked or malformed file refuses; an existing spend map is validated and left
byte-identical (it is never emptied, repaired or recreated); evidence of earlier paid use without a spend map refuses.
A NEW spend map is written only against the stopped pre-paid baseline taken by install.sh: the counters bytes and the
ledger must be exactly what that baseline recorded (nothing ran since), and the ledger must exist and hold no paid row.
A ledger without paid rows is not by itself proof of "never paid" (a reservation is written before its ledger row).
Usage: init_spend.py <counters.json> <requests.jsonl> <pre-paid-baseline.json>     exit 0 = initialised or already valid, 1 = refused"""
import hashlib, json, os, re, stat, sys

def refuse(msg): print(f'REFUSE: {msg}'); sys.exit(1)
def micro(v): return type(v) is int and 0 <= v <= 2**53 - 1
def day_ok(k):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', k): return False
    import datetime
    try: datetime.date.fromisoformat(k); return True
    except ValueError: return False

def main(path, ledger, baseline):
    try: fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e: refuse(f'counters file cannot be opened without following a link ({e.strerror})')
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_size > 1_000_000: refuse('counters file is not a small regular file owned by this user')
        raw = os.read(fd, 1_000_001)
    finally: os.close(fd)
    def no_dup(pairs):
        keys = [k for k, _ in pairs]
        if len(keys) != len(set(keys)): raise ValueError('duplicate key')
        return dict(pairs)
    try: s = json.loads(raw, object_pairs_hook=no_dup)
    except ValueError: refuse('counters file is not valid JSON')
    if type(s) is not dict or not all(micro(s.get(k)) for k in ('hour_start', 'hour', 'day_start', 'day')): refuse('counters are missing or not non-negative integers')
    if 'spend' in s:
        sp = s['spend']
        if type(sp) is not dict or not all(day_ok(k) and micro(v) for k, v in sp.items()): refuse('existing spend map is malformed; it is not repaired here')
        print(f'ok  spend map already present ({len(sp)} day(s)); file left untouched'); return
    # No spend map. It may be created only if this state never ran paid: a ledger row carrying a reservation says it did.
    try: led = open(ledger, 'rb').read()
    except OSError: refuse('the request ledger is missing or unreadable; first-paid initialisation cannot be shown')
    if b'"reserved_micro"' in led: refuse('the request ledger shows earlier paid use but the spend map is gone; never recreated as empty')
    try: base = json.load(open(baseline))
    except (OSError, ValueError): refuse('the stopped pre-paid baseline is missing or unreadable')
    if base.get('counters_sha256') != hashlib.sha256(raw).hexdigest(): refuse('counters changed since the stopped pre-paid baseline')
    if base.get('ledger_sha256') != hashlib.sha256(led).hexdigest(): refuse('the ledger changed since the stopped pre-paid baseline')
    s['spend'] = {}
    d = os.path.dirname(path) or '.'
    tmp = path + '.init-spend.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, json.dumps(s, separators=(',', ':')).encode()); os.fsync(fd)
    finally: os.close(fd)
    os.rename(tmp, path)
    dfd = os.open(d, os.O_RDONLY)
    try: os.fsync(dfd)
    finally: os.close(dfd)
    back = json.loads(open(path, 'rb').read())
    if back != s or {k: v for k, v in back.items() if k != 'spend'} != {k: v for k, v in json.loads(raw).items()}: refuse('read-back differs from the intended state')
    print('ok  spend map initialised empty; every existing counter and key preserved')

if __name__ == '__main__':
    if len(sys.argv) != 4: refuse('usage: init_spend.py <counters.json> <requests.jsonl> <pre-paid-baseline.json>')
    main(*sys.argv[1:])
