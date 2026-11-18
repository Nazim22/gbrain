#!/bin/bash
# S603: start the installed (or rolled-back) bridge and bind the running process to the selected bundle. Root, attended.
# Usage: start_live.sh <sha>
# Accepts only when bind_running holds (script, start time after the swap, interpreter, effective config) and
# /v1/bridge/status answers 200 with halted:null. After a forward install it also needs the startup identity the
# bundle reports (script and config sha256) to equal the manifest and the pinned config. A pre-S603 bundle reached by
# --rollback-to reports none, so that check applies only to forward installs.
# Any mismatch: the unit is stopped and the ledger rows since start are printed as the record of what that process may
# have handled. That is evidence, not a claim that nothing was sent. Nothing is retried.
set -euo pipefail
SHA=${1:?usage: start_live.sh <sha>}; OPTROOT=/opt/chatgpt-plan-bridge; E=/etc/chatgpt-plan-bridge; PORT=18795
LEDGER=/srv/chatgpt-plan-bridge/state/requests.jsonl
source "$(cd "$(dirname "$0")" && pwd)/canary_lib.sh"
step() { echo "== $(date -u +%FT%TZ) $*"; }
[[ $(readlink "$OPTROOT/current") == "$OPTROOT/$SHA" ]] || { echo "REFUSE: current does not name $SHA"; exit 1; }
[[ $(systemctl is-active chatgpt-plan-bridge.service || true) == inactive ]] || { echo "REFUSE: the bridge is not stopped"; exit 1; }
no_bridge_process || { echo "REFUSE: a cpbridge process is running, or the process list could not be read"; exit 1; }
PIN=$(< $E/config.pinned.sha256); SWAP=$(< $E/swap.epoch); MODE=$(< $E/swap.mode)
LINES=$(wc -l < "$LEDGER")

step "start $SHA ($MODE)"
systemctl enable --now chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.timer
stop_and_record() {
  echo "$1"; systemctl stop chatgpt-plan-bridge.service || true
  echo "ledger rows written since start (what that process may have handled):"; tail -n +$((LINES + 1)) "$LEDGER" || true
  exit 1
}
for _ in $(seq 1 20); do PID=$(systemctl show -p MainPID --value chatgpt-plan-bridge.service); [[ $PID != 0 ]] && break; sleep 0.5; done
[[ ${PID:-0} != 0 ]] || stop_and_record "STOP: no main PID"
bind_running "$PID" "$OPTROOT" "$SHA" "$E/config.json" "$PIN" "$SWAP" || stop_and_record "STOP: the running process does not bind to $SHA"
echo "bound: pid $PID runs $OPTROOT/$SHA (script, start after swap, interpreter, config)"

for _ in $(seq 1 20); do
  resp=$(printf 'header = "Authorization: Bearer %s"\n' "$(< $E/caller.secret)" | curl -sS -K - -w '\n%{http_code}' http://127.0.0.1:$PORT/v1/bridge/status 2>/dev/null) && break; sleep 0.5
done
code=${resp##*$'\n'} body=${resp%$'\n'*}
[[ $code == 200 ]] || stop_and_record "STOP: status=$code (want 200)"
printf '%s' "$body" | python3 -I - "$MODE" "$OPTROOT/$SHA" "$PIN" <<'PY' || stop_and_record "STOP: status or startup identity does not bind"
import json, sys
mode, b, pin = sys.argv[1:]; d = json.load(sys.stdin)
assert d.get('halted') is None, f"halted: {d.get('halted')}"
if mode == 'forward':
    i = d.get('identity') or {}
    m = dict(reversed(l.split(None, 1)) for l in open(f'{b}/MANIFEST.sha256').read().split('\n') if l)
    assert i.get('script_sha256') == m['bridge.js'], 'script_sha256 differs from the manifest'
    assert i.get('config_sha256') == pin, 'config_sha256 differs from the pinned config'
    print('identity bound:', i['script_sha256'][:16], i['config_sha256'][:16])
print('status 200, halted null, routes', d['routes'])
PY
step "live on $SHA"
