#!/bin/bash
# Back from paid mode to the plan install that was there before (GBRAIN-S593, PAID-RUNBOOK.md rollback). Root, attended.
# Restores the saved plan config BYTES and the bundle 'current' pointed at, and the old units. It does NOT re-run the old
# installer (which would move the sign-in again and start the service), does not clear a latch, does not touch counters
# (the spend map stays; plan mode ignores and preserves it) or the key file, and leaves the bridge STOPPED.
# Usage: rollback-paid.sh <old-bridge-worktree> <old-head-sha>
set -euo pipefail
OLDW=$1 OLD=$2; E=/etc/chatgpt-plan-bridge; OLDOPT=/opt/chatgpt-plan-bridge/$OLD
step() { echo "== $(date -u +%FT%TZ) $*"; }
[[ $(git -C "$OLDW" rev-parse HEAD) == "$OLD" && -z $(git -C "$OLDW" status --porcelain) ]] || { echo "REFUSE: $OLDW is not clean at $OLD"; exit 1; }
[[ -s $E/config.json.pre-paid && -s $E/current.pre-paid && ! -L $E/config.json.pre-paid ]] || { echo "REFUSE: rollback preimages are missing"; exit 1; }
[[ $(< $E/current.pre-paid) == "$OLDOPT" && -d $OLDOPT && ! -L $OLDOPT ]] || { echo "REFUSE: the recorded previous bundle is $(< $E/current.pre-paid), not $OLDOPT"; exit 1; }
step "stop"
systemctl disable --now chatgpt-plan-bridge.service
systemctl stop cpbridge-paid-canary.service 2>/dev/null || true
if pgrep -u cpbridge >/dev/null; then echo "REFUSE: a cpbridge process is still running"; exit 1; fi
step "restore config bytes, bundle link and units"
install -m 0640 -o root -g cpbridge $E/config.json.pre-paid $E/config.json.rollback-tmp && mv $E/config.json.rollback-tmp $E/config.json
ln -sfn "$OLDOPT" /opt/chatgpt-plan-bridge/current
for u in chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.service chatgpt-plan-bridge-egress.timer; do install -m 0644 "$OLDW/tools/chatgpt-plan-bridge/deploy/$u" /etc/systemd/system/$u; done
systemctl daemon-reload
step "read back"
cmp $E/config.json $E/config.json.pre-paid && echo "ok  config.json == the saved plan config ($(sha256sum $E/config.json | cut -c1-16))"
[[ $(readlink /opt/chatgpt-plan-bridge/current) == "$OLDOPT" ]] && echo "ok  current -> $OLDOPT"
! grep -q '"api_key"' $E/config.json && echo "ok  config is plan mode"
python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print("ok  counters kept:", {k:(v if k!="spend" else f"{len(v)} day(s)") for k,v in c.items()})' /srv/chatgpt-plan-bridge/state/counters.json
# The old verifier binds bundle, runtime, detectors and units to the old source. It is expected to stop at config.json,
# exactly as it did before the change (the live plan config carried hand edits); compare with the saved baseline.
V=$(mktemp $E/.rollback-verify.XXXXXX)
python3 -I "$OLDW/tools/chatgpt-plan-bridge/deploy/verify_install.py" "$OLDW" > "$V" 2>&1 || true
cat "$V"
if [[ -s $E/verify-baseline.pre-paid ]]; then cmp "$V" $E/verify-baseline.pre-paid && echo "ok  old verifier output identical to the pre-change baseline" || { echo "STOP: old verifier output differs from the pre-change baseline"; rm -f "$V"; exit 1; }; else echo "note: no pre-change verifier baseline was saved; judge the output above by hand"; fi
rm -f "$V"
step "rolled back to $OLD; the bridge is STOPPED and disabled. Start it only when its own prerequisites hold: systemctl enable --now chatgpt-plan-bridge.service"
