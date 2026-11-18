"""Bind the INSTALLED chatgpt-plan-bridge to a reviewed worktree's bytes (canary.sh V: reuse instead of reinstalling).
On disk only (canary.sh V adds the live checks: units active, egress drop, 401/200, latch clear, route):
- /opt/chatgpt-plan-bridge/current -> /opt/chatgpt-plan-bridge/<40-hex>, nothing else symlinked;
- bridge.js == a fresh `bun build` of the worktree's tools (same command as install.sh, into a root-only temp dir);
- detector_check.py, egress.sh and the 3 systemd units == the worktree copies; bun == the runtime that just built the bundle;
- redactor.py == the pin, config.json == install.sh's own heredoc rendered for that dir (one source: install.sh);
- owner/mode of the home, leaf dirs, secret and config as install.sh sets them.
paid (GBRAIN-S593): config.json == install.sh's PAID heredoc; the API key file passes the same custody the bridge enforces at
start (custody.ts: regular file, root:cpbridge 0640, bounded printable ASCII, real root-owned ancestors nobody else can write,
outside the state dir) and is never printed or hashed; counters.json holds a valid spend map; the rollback preimages exist.
Exit 1 at the first mismatch. Usage: verify_install.py <worktree> [paid] [<opt_root> <etc_dir> <unit_dir>]  (roots: tests only)"""
import hashlib, json, os, re, stat, subprocess, sys, tempfile
W = sys.argv[1]
PAID = len(sys.argv) > 2 and sys.argv[2] == 'paid'
ROOTS = sys.argv[3:] if PAID else sys.argv[2:]
if len(ROOTS) not in (0, 3): print('usage: verify_install.py <worktree> [paid] [<opt_root> <etc_dir> <unit_dir>]'); sys.exit(1)
OPT_ROOT, ETC, UNITS = (ROOTS if ROOTS else ['/opt/chatgpt-plan-bridge', '/etc/chatgpt-plan-bridge', '/etc/systemd/system'])
SRC = f'{W}/tools/chatgpt-plan-bridge'; BUN = os.path.realpath('/root/.bun/bin/bun'); SRV = '/srv/chatgpt-plan-bridge'

def fail(msg): print(f'REFUSE: {msg}'); sys.exit(1)
def sha(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
def same(installed, reviewed, what):
    if sha(installed) != sha(reviewed): fail(f'{what} differs from the reviewed bytes ({installed})')
    print(f'ok  {what}  {sha(installed)[:16]}')
def owned(p, user, group, mode):
    s = os.lstat(p)
    if stat.S_ISLNK(s.st_mode): fail(f'{p} is a symlink')
    import pwd, grp
    got = (pwd.getpwuid(s.st_uid).pw_name, grp.getgrgid(s.st_gid).gr_name, stat.S_IMODE(s.st_mode))
    if got != (user, group, mode): fail(f'{p} is {got[0]}:{got[1]} {oct(got[2])}, want {user}:{group} {oct(mode)}')
    print(f'ok  {p}  {user}:{group} {oct(mode)}')

cur = os.readlink(f'{OPT_ROOT}/current') if os.path.islink(f'{OPT_ROOT}/current') else fail('current is not a symlink')
opt = cur if os.path.isabs(cur) else os.path.join(OPT_ROOT, cur)
if not re.fullmatch(re.escape(OPT_ROOT) + r'/[0-9a-f]{40}', opt): fail(f'current -> {cur}, not a <sha> dir under {OPT_ROOT}')
for p in [OPT_ROOT, opt, f'{opt}/detectors', ETC, SRV, f'{SRV}/auth', f'{SRV}/state', f'{SRV}/tmp']:
    if os.path.islink(p): fail(f'{p} is a symlink')
print(f'ok  installed dir {opt}')

with tempfile.TemporaryDirectory() as t:   # root-only (0700) temp dir: nothing the bridge user can reach
    subprocess.run([BUN, 'build', 'tools/chatgpt-plan-bridge/main.ts', '--target=bun', '--outfile', f'{t}/bridge.js'], cwd=W, check=True, capture_output=True)
    same(f'{opt}/bridge.js', f'{t}/bridge.js', 'bridge.js (fresh bundle of the reviewed tools)')
same(f'{opt}/bun', BUN, 'bun runtime')
same(f'{opt}/detectors/detector_check.py', f'{SRC}/detector_check.py', 'detector_check.py')
same(f'{opt}/egress.sh', f'{SRC}/deploy/egress.sh', 'egress.sh')
if PAID: same(f'{opt}/init_spend.py', f'{SRC}/deploy/init_spend.py', 'init_spend.py')
for u in ['chatgpt-plan-bridge.service', 'chatgpt-plan-bridge-egress.service', 'chatgpt-plan-bridge-egress.timer']:
    same(f'{UNITS}/{u}', f'{SRC}/deploy/{u}', u)

inst = open(f'{SRC}/deploy/install.sh').read()
tpl = re.search(r"cat > /etc/chatgpt-plan-bridge/config.json <<EOF_PAID\n(.*?)\nEOF_PAID\n" if PAID else r"cat > /etc/chatgpt-plan-bridge/config.json <<EOF\n(.*?)\nEOF\n", inst, re.S)
port = re.search(r'\bPORT=(\d+)\b', inst)
if not tpl or not port: fail('cannot find the config heredoc / PORT in install.sh')
want = json.loads(tpl.group(1).replace('$PORT', port.group(1)).replace('$OPT', opt))
# S603 upgrade: install.sh preserves the running config (repoint_config). The expected config is then the PINNED
# pre-upgrade config with only the two detector paths moved to this bundle, never the fresh-install template. Every check
# below (redactor pin, key custody, state dir, ceilings) runs on that expected config.
_mode = f'{ETC}/swap.mode'
if os.path.exists(f'{ETC}/rollback.manifest') and os.path.exists(_mode) and open(_mode).read().strip() == 'forward':
    _lines = open(f'{ETC}/rollback.manifest').read().splitlines()
    _old = next((l[len('# sha '):] for l in _lines if l.startswith('# sha ')), None)
    _cpin = next((l[len('# config '):] for l in _lines if l.startswith('# config ')), None)
    if not _old or not re.fullmatch(r'[0-9a-f]{40}', _old) or not _cpin: fail('the upgrade pin (rollback.manifest) is incomplete')
    if sha(f'{ETC}/rollback.config.json') != _cpin: fail('rollback.config.json differs from its pinned hash')
    if f'{OPT_ROOT}/{_old}' != opt:
        want = json.load(open(f'{ETC}/rollback.config.json'))
        for _k, _f in (('redactor', 'redactor.py'), ('detector_check', 'detector_check.py')):
            if want['leak'][_k] != f'{OPT_ROOT}/{_old}/detectors/{_f}': fail(f'pinned config leak.{_k} is not the pinned bundle\'s')
            want['leak'][_k] = f'{opt}/detectors/{_f}'
        print(f'ok  upgrade from {_old[:12]}: expecting the pinned pre-upgrade config with only the detector paths moved')
got = json.load(open(f'{ETC}/config.json'))
if got != want: fail(f'config.json differs from the expected config for {opt}: {sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))}')
print(f"ok  config.json == install.sh {'PAID ' if PAID else ''}heredoc")
if sha(f'{opt}/detectors/redactor.py') != want['leak']['redactor_sha256']: fail('redactor.py differs from its pin')
print(f'ok  redactor.py pinned {want["leak"]["redactor_sha256"][:16]}')

owned(SRV, 'root', 'root', 0o755)
for d in ['auth', 'state', 'tmp']: owned(f'{SRV}/{d}', 'cpbridge', 'cpbridge', 0o700)
owned(f'{ETC}/caller.secret', 'root', 'cpbridge', 0o640)
if os.path.getsize(f'{ETC}/caller.secret') == 0: fail('caller.secret is empty')
owned(f'{ETC}/config.json', 'root', 'cpbridge', 0o640)
if PAID:
    key = want['upstream']['api_key_file']
    if os.path.normpath(key) != key or not key.startswith(ETC + '/') or key.startswith(want['state_dir'] + '/'): fail('api_key_file is not a normalised path under the config dir, outside the state dir')
    d = os.path.dirname(key)
    while True:   # every ancestor: a real directory, root-owned, not writable by group or others (custody.ts)
        a = os.lstat(d)
        if not stat.S_ISDIR(a.st_mode) or a.st_uid != 0 or stat.S_IMODE(a.st_mode) & 0o022: fail(f'key ancestor {d} is not a root-owned directory closed to group/other writes')
        if d == '/': break
        d = os.path.dirname(d)
    owned(key, 'root', 'cpbridge', 0o640)
    if not stat.S_ISREG(os.lstat(key).st_mode): fail('key file is not a regular file')
    kb = open(key, 'rb').read(402)
    if not re.fullmatch(rb'[\x21-\x7e]{20,400}\n?', kb): fail('key file content is not 20..400 printable ASCII characters')   # content never printed or hashed
    print('ok  key file custody (content not shown)')
    cpath = f"{want['state_dir']}/counters.json"
    owned(cpath, 'cpbridge', 'cpbridge', 0o600)
    if not stat.S_ISREG(os.lstat(cpath).st_mode): fail('counters.json is not a regular file')
    def no_dup(pairs):
        if len({k for k, _ in pairs}) != len(pairs): fail('counters.json has a duplicate key')
        return dict(pairs)
    c = json.loads(open(cpath, 'rb').read(), object_pairs_hook=no_dup)
    import datetime
    def real_day(k):
        try: datetime.date.fromisoformat(k); return True
        except ValueError: return False
    nn = lambda v: type(v) is int and 0 <= v <= 2**53 - 1
    if not all(nn(c.get(k)) for k in ('hour_start', 'hour', 'day_start', 'day')): fail('counters.json counters are not non-negative integers')
    sp = c.get('spend')
    if type(sp) is not dict or not all(re.fullmatch(r'\d{4}-\d{2}-\d{2}', k) and real_day(k) and nn(v) for k, v in sp.items()): fail('counters.json has no valid spend map')
    if any(v > want['ceilings']['usd_micro_per_day'] for v in sp.values()): fail('a recorded day exceeds the configured ceiling')
    print(f'ok  counters.json spend map valid ({len(sp)} day(s))')
    for pre in ('config.json.pre-paid', 'current.pre-paid', 'pre-paid-baseline.json', 'verify-baseline.pre-paid'):
        if not os.path.isfile(f'{ETC}/{pre}') or os.path.islink(f'{ETC}/{pre}') or os.path.getsize(f'{ETC}/{pre}') == 0: fail(f'rollback preimage {pre} is missing')
    if not os.path.isdir(f'{ETC}/units.pre-paid') or os.path.islink(f'{ETC}/units.pre-paid'): fail('rollback unit preimages are missing')
    print('ok  rollback preimages and stopped pre-paid baseline present')
print(f"VERIFIED: the installed bridge is the reviewed bytes{' (paid mode)' if PAID else ''}")
