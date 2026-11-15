#!/bin/bash
# Back from paid mode to the plan install that was there before (GBRAIN-S593, PAID-RUNBOOK.md rollback). Root, attended.
# Restores the saved plan config BYTES, the bundle 'current' pointed at and the saved unit BYTES, all recorded by
# install.sh paid in the stopped state. It does NOT re-run the old installer (which would move the sign-in again and start
# the service), does not clear a latch, does not touch counters (the spend map stays; plan mode ignores and preserves it)
# or the key file, and leaves the bridge STOPPED. Without the complete pre-paid baseline it refuses: nothing is guessed.
# Usage: rollback-paid.sh <old-bridge-worktree> <old-head-sha>
set -euo pipefail
OLDW=$1 OLD=$2; E=/etc/chatgpt-plan-bridge; OLDOPT=/opt/chatgpt-plan-bridge/$OLD
UNITS="chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.service chatgpt-plan-bridge-egress.timer"
step() { echo "== $(date -u +%FT%TZ) $*"; }
[[ $(git -C "$OLDW" rev-parse HEAD) == "$OLD" && -z $(git -C "$OLDW" status --porcelain) ]] || { echo "REFUSE: $OLDW is not clean at $OLD"; exit 1; }
for f in config.json.pre-paid current.pre-paid pre-paid-baseline.json verify-baseline.pre-paid; do [[ -s $E/$f && ! -L $E/$f ]] || { echo "REFUSE: pre-paid baseline piece $f is missing"; exit 1; }; done
for u in $UNITS; do [[ -s $E/units.pre-paid/$u && ! -L $E/units.pre-paid/$u ]] || { echo "REFUSE: saved unit $u is missing"; exit 1; }; done
[[ $(< $E/current.pre-paid) == "$OLDOPT" && -d $OLDOPT && ! -L $OLDOPT ]] || { echo "REFUSE: the recorded previous bundle is $(< $E/current.pre-paid), not $OLDOPT"; exit 1; }
# The saved pieces must still be the ones the baseline recorded.
python3 -I - "$E" <<'PY'
import hashlib, json, sys
E = sys.argv[1]; b = json.load(open(f'{E}/pre-paid-baseline.json')); sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
assert sha(f'{E}/config.json.pre-paid') == b['config_sha256'], 'saved config differs from the baseline'
assert open(f'{E}/current.pre-paid').read().strip() == b['current'], 'saved current differs from the baseline'
for u, h in b['units_sha256'].items(): assert sha(f'{E}/units.pre-paid/{u}') == h, f'saved unit {u} differs from the baseline'
print('ok  saved config, current and units match the stopped pre-paid baseline taken', b['taken_at'])
PY
step "stop"
systemctl disable --now chatgpt-plan-bridge.service
systemctl stop cpbridge-paid-canary.service 2>/dev/null || true
if pgrep -u cpbridge >/dev/null; then echo "REFUSE: a cpbridge process is still running"; exit 1; fi
step "restore config bytes, bundle link and unit bytes"
install -m 0640 -o root -g cpbridge $E/config.json.pre-paid $E/config.json.rollback-tmp && mv $E/config.json.rollback-tmp $E/config.json
ln -sfn "$OLDOPT" /opt/chatgpt-plan-bridge/current
for u in $UNITS; do install -m 0644 $E/units.pre-paid/$u /etc/systemd/system/$u; done
systemctl daemon-reload
step "read back (every line must hold; any failure exits non-zero with the bridge stopped)"
cmp $E/config.json $E/config.json.pre-paid; echo "ok  config.json == the saved plan config ($(sha256sum $E/config.json | cut -c1-16))"
[[ $(readlink /opt/chatgpt-plan-bridge/current) == "$OLDOPT" ]]; echo "ok  current -> $OLDOPT"
for u in $UNITS; do cmp /etc/systemd/system/$u $E/units.pre-paid/$u; done; echo "ok  the three units == the saved unit bytes"
! grep -q '"api_key"' $E/config.json; echo "ok  config is plan mode"
# The old verifier binds bundle, runtime, detector_check, egress.sh and units to the old source, then stops at config.json
# on this host (recorded hand edits). Its output must equal the step-0 baseline byte for byte, refusal included.
V=$(mktemp $E/.rollback-verify.XXXXXX); trap 'rm -f "$V"' EXIT
python3 -I "$OLDW/tools/chatgpt-plan-bridge/deploy/verify_install.py" "$OLDW" > "$V" 2>&1 || true
cat "$V"
cmp "$V" $E/verify-baseline.pre-paid; echo "ok  old verifier output identical to the step-0 baseline"
# What that verifier does not reach when it stops at config.json: the detector files the restored config names, the
# redactor pin, and the owner/mode of the home, leaf dirs, secret and config.
python3 -I - "$E" <<'PY'
import grp, hashlib, json, os, pwd, stat, sys
E = sys.argv[1]; c = json.load(open(f'{E}/config.json')); L = c['leak']
def owned(p, user, group, mode):
    s = os.lstat(p); assert not stat.S_ISLNK(s.st_mode), f'{p} is a symlink'
    got = (pwd.getpwuid(s.st_uid).pw_name, grp.getgrgid(s.st_gid).gr_name, stat.S_IMODE(s.st_mode))
    assert got == (user, group, mode), f'{p} is {got}, want {(user, group, oct(mode))}'
for k in ('detector_check', 'redactor'):
    assert os.path.isfile(L[k]) and not os.path.islink(L[k]), f'detector file {L[k]} named by the restored config is missing'
assert hashlib.sha256(open(L['redactor'], 'rb').read()).hexdigest() == L['redactor_sha256'], 'redactor differs from its pin'
SRV = '/srv/chatgpt-plan-bridge'; owned(SRV, 'root', 'root', 0o755)
for d in ('auth', 'state', 'tmp'): owned(f'{SRV}/{d}', 'cpbridge', 'cpbridge', 0o700)
owned(f'{E}/caller.secret', 'root', 'cpbridge', 0o640); owned(f'{E}/config.json', 'root', 'cpbridge', 0o640)
k = json.load(open(f'{SRV}/state/counters.json'))
print('ok  detector files present, redactor pinned, owners and modes as installed; counters kept:', {a: (v if a != 'spend' else f'{len(v)} day(s)') for a, v in k.items()})
PY
step "rolled back to $OLD; the bridge is STOPPED and disabled. Start it only when its own prerequisites hold: systemctl enable --now chatgpt-plan-bridge.service"
