"""Bind the INSTALLED chatgpt-plan-bridge to a reviewed worktree's bytes (canary.sh V: reuse instead of reinstalling).
On disk only (canary.sh V adds the live checks: units active, egress drop, 401/200, latch clear, route):
- /opt/chatgpt-plan-bridge/current -> /opt/chatgpt-plan-bridge/<40-hex>, nothing else symlinked;
- bridge.js == a fresh `bun build` of the worktree's tools (same command as install.sh, into a root-only temp dir);
- detector_check.py, egress.sh and the 3 systemd units == the worktree copies; bun == the runtime that just built the bundle;
- redactor.py == the pin, config.json == install.sh's own heredoc rendered for that dir (one source: install.sh);
- owner/mode of the home, leaf dirs, secret and config as install.sh sets them.
Exit 1 at the first mismatch. Usage: verify_install.py <worktree> [<opt_root> <etc_dir> <unit_dir>]  (roots: tests only)"""
import hashlib, json, os, re, stat, subprocess, sys, tempfile
W = sys.argv[1]
OPT_ROOT, ETC, UNITS = (sys.argv[2:5] if len(sys.argv) == 5 else ['/opt/chatgpt-plan-bridge', '/etc/chatgpt-plan-bridge', '/etc/systemd/system'])
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
for u in ['chatgpt-plan-bridge.service', 'chatgpt-plan-bridge-egress.service', 'chatgpt-plan-bridge-egress.timer']:
    same(f'{UNITS}/{u}', f'{SRC}/deploy/{u}', u)

inst = open(f'{SRC}/deploy/install.sh').read()
tpl = re.search(r"cat > /etc/chatgpt-plan-bridge/config.json <<EOF\n(.*?)\nEOF\n", inst, re.S)
port = re.search(r'\bPORT=(\d+)\b', inst)
if not tpl or not port: fail('cannot find the config heredoc / PORT in install.sh')
want = json.loads(tpl.group(1).replace('$PORT', port.group(1)).replace('$OPT', opt))
got = json.load(open(f'{ETC}/config.json'))
if got != want: fail(f'config.json differs from install.sh for {opt}: {sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))}')
print('ok  config.json == install.sh heredoc')
if sha(f'{opt}/detectors/redactor.py') != want['leak']['redactor_sha256']: fail('redactor.py differs from its pin')
print(f'ok  redactor.py pinned {want["leak"]["redactor_sha256"][:16]}')

owned(SRV, 'root', 'root', 0o755)
for d in ['auth', 'state', 'tmp']: owned(f'{SRV}/{d}', 'cpbridge', 'cpbridge', 0o700)
owned(f'{ETC}/caller.secret', 'root', 'cpbridge', 0o640)
if os.path.getsize(f'{ETC}/caller.secret') == 0: fail('caller.secret is empty')
owned(f'{ETC}/config.json', 'root', 'cpbridge', 0o640)
print('VERIFIED: the installed bridge is the reviewed bytes')
