"""Live half of canary.sh V (verify_install.py binds the files on disk; this binds what is RUNNING):
1. Egress confinement: `nft list table inet filter` must hold exactly the chains egress.sh's own heredoc creates (one source:
   egress.sh), rendered for this host: the gate is a base chain on the output hook whose ONLY rule jumps the bridge uid
   into cpbridge_egress, and cpbridge_egress holds exactly the allow rules in order, then the counted drop. An orphan or
   re-hooked gate, any extra rule (an accept before the drop), a reorder or another uid is refused.
2. Units: the 3 units load from /etc/systemd/system with no drop-ins and no pending daemon-reload.
3. Process: the bridge's MainPID runs as cpbridge, its exe is the verified bun, its argv is the unit's ExecStart, and no
   bound file is newer than the process start (else the running code may not be what is on disk).
Exit 1 at the first mismatch. Usage: verify_live.py <worktree> [--nft-file F] [--opt DIR]  (overrides: tests only)"""
import argparse, glob, ipaddress, os, pwd, re, subprocess, sys
ap = argparse.ArgumentParser(); ap.add_argument('worktree'); ap.add_argument('--nft-file'); ap.add_argument('--opt'); a = ap.parse_args()
SRC = f'{a.worktree}/tools/chatgpt-plan-bridge/deploy'; UNITS = ['chatgpt-plan-bridge.service', 'chatgpt-plan-bridge-egress.service', 'chatgpt-plan-bridge-egress.timer']
def fail(msg): print(f'REFUSE: {msg}'); sys.exit(1)
def run(*cmd): return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
uid = pwd.getpwnam('cpbridge').pw_uid

# 1. egress: expected chains from egress.sh's heredoc, rendered as `add` renders it on this host
sh = open(f'{SRC}/egress.sh').read()
hd = re.search(r"nft -f - <<EOF\n(.*?)\nEOF\n", sh, re.S); chain = re.search(r'\bCHAIN=(\S+)', sh); port = re.search(r'PORT=\$\{CPBRIDGE_PORT:-(\d+)\}', sh)
if not (hd and chain and port): fail('cannot read the chain heredoc / CHAIN / PORT from egress.sh')
ns = [l.split()[1] for l in open('/etc/resolv.conf').read().splitlines() if l.startswith('nameserver ')]
if len(ns) != 1: fail('one frozen resolver required (egress.sh add rule)')
resolver = str(ipaddress.ip_address(ns[0])); fam = 'ip6' if ':' in resolver else 'ip'
text = hd.group(1).replace('${CHAIN}', chain.group(1))
for k, v in {'$CHAIN': chain.group(1), '$PORT': port.group(1), '$uid': str(uid), '$fam': fam, '$resolver': resolver}.items(): text = text.replace(k, v)
want = {}
for l in text.splitlines():
    if m := re.fullmatch(r'add chain inet filter (\S+)(?: \{ (.*) \})?', l.strip()): want[m[1]] = ([m[2].strip().rstrip(';')] if m[2] else [])
    elif m := re.fullmatch(r'add rule inet filter (\S+) (.*)', l.strip()): want[m[1]].append(m[2])
live, cur, depth = {}, None, 0
listing = open(a.nft_file).read() if a.nft_file else run('nft', 'list', 'table', 'inet', 'filter')
for raw in listing.splitlines():
    l = raw.strip()
    if depth == 1 and (m := re.fullmatch(r'chain (\S+) \{', l)): cur = m[1]; live[cur] = []; depth = 2; continue
    if cur and depth == 2 and l == '}': cur = None; depth = 1; continue
    if cur and depth == 2 and l:
        l = re.sub(r'counter packets \d+ bytes \d+', 'counter', l)
        l = re.sub(r'priority filter - (\d+)', r'priority -\1', l); l = re.sub(r'priority filter(?! [-+])', 'priority 0', l)
        live[cur].append(l.rstrip(';'))
    depth += raw.count('{') - raw.count('}')
for c, rules in want.items():
    if c not in live: fail(f'nft chain {c} is missing')
    if live[c] != rules: fail(f'nft chain {c} differs from egress.sh:\n  want {rules}\n  live {live[c]}')
    print(f'ok  nft {c}: {len(rules)} line(s) exactly as egress.sh renders them')

# 2. units load exactly the verified files
for u in UNITS:
    p = dict(l.split('=', 1) for l in run('systemctl', 'show', u, '-p', 'FragmentPath', '-p', 'DropInPaths', '-p', 'NeedDaemonReload').splitlines())
    if p != {'FragmentPath': f'/etc/systemd/system/{u}', 'DropInPaths': '', 'NeedDaemonReload': 'no'}: fail(f'{u}: {p}')
    print(f'ok  {u}: fragment only, no drop-ins, no pending reload')

# 3. the running bridge is the verified bytes
p = dict(l.split('=', 1) for l in run('systemctl', 'show', UNITS[0], '-p', 'MainPID', '-p', 'ExecMainStartTimestamp', '--timestamp=unix').splitlines())
pid, start = int(p['MainPID']), int(p['ExecMainStartTimestamp'].lstrip('@') or 0)
if pid <= 0 or start <= 0: fail(f'bridge not running: {p}')
opt = a.opt or os.path.realpath('/opt/chatgpt-plan-bridge/current')
bound = [f'{opt}/bridge.js', f'{opt}/bun', f'{opt}/egress.sh', *glob.glob(f'{opt}/detectors/*'), '/etc/chatgpt-plan-bridge/config.json', '/etc/chatgpt-plan-bridge/caller.secret']
newer = [f for f in bound if os.stat(f).st_mtime > start]
if newer: fail(f'newer than the running process (started @{start}): {newer}')
print(f'ok  {len(bound)} bound files all predate the process start @{start}')
ids = [l.split()[1:] for l in open(f'/proc/{pid}/status') if l.startswith(('Uid:', 'Gid:'))]
if any(int(x) != uid for x in ids[0]): fail(f'pid {pid} uids {ids[0]} != cpbridge {uid}')
if os.path.realpath(f'/proc/{pid}/exe') != os.path.realpath(f'{opt}/bun'): fail(f'pid {pid} exe {os.path.realpath(f"/proc/{pid}/exe")} is not {opt}/bun')
argv = open(f'/proc/{pid}/cmdline').read().split('\0')[:-1]
if argv != ['/opt/chatgpt-plan-bridge/current/bun', '/opt/chatgpt-plan-bridge/current/bridge.js', '/etc/chatgpt-plan-bridge/config.json']: fail(f'pid {pid} argv {argv}')
print(f'ok  pid {pid}: uid cpbridge, exe = verified bun, argv = unit ExecStart')
print('VERIFIED: the running bridge and its egress confinement are the reviewed ones')
