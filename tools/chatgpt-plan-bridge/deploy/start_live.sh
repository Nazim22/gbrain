#!/bin/bash
# S603: start the installed (or rolled-back) bridge and bind the running process to the selected bundle. Root, attended.
# Usage: start_live.sh <sha>
# Accepts only when bind_running holds (script, start time after the swap, interpreter, effective config) and
# /v1/bridge/status answers 200 with halted:null. After a forward install it also needs the startup identity the
# bundle reports (script and config sha256) to equal the manifest and the pinned config. A pre-S603 bundle reached by
# --rollback-to reports none, so that check applies only to forward installs.
# Containment: from the moment `enable --now` is issued, ANY exit other than full success stops the unit and then
# proves it inactive with no cpbridge process. If that cannot be proven (stop failed, still active, process list
# unreadable), it says CONTAINMENT UNKNOWN. The ledger rows written since start are printed as the record of what the
# process may have handled. That is evidence, not a claim that nothing was sent. Nothing is retried.
# Test seams (start_live.test.sh): OPTROOT, ETC, LEDGER, PORT, SYSTEMCTL, CURL, BIND, SLEEP.
set -euo pipefail
SHA=${1:?usage: start_live.sh <sha>}
OPTROOT=${OPTROOT:-/opt/chatgpt-plan-bridge}; E=${ETC:-/etc/chatgpt-plan-bridge}; PORT=${PORT:-18795}
LEDGER=${LEDGER:-/srv/chatgpt-plan-bridge/state/requests.jsonl}
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/canary_lib.sh"
: "${CURL:=curl}" "${BIND:=bind_running}"
step() { echo "== $(date -u +%FT%TZ) $*"; }

[[ $(readlink "$OPTROOT/current") == "$OPTROOT/$SHA" ]] || { echo "REFUSE: current does not name $SHA"; exit 1; }
[[ $($SYSTEMCTL is-active chatgpt-plan-bridge.service || true) == inactive ]] || { echo "REFUSE: the bridge is not stopped"; exit 1; }
no_bridge_process || { echo "REFUSE: a cpbridge process is running, or the process list could not be read"; exit 1; }
PIN=$(< "$E/config.pinned.sha256"); SWAP=$(< "$E/swap.epoch"); MODE=$(< "$E/swap.mode")
LINES=$(wc -l < "$LEDGER")

STARTED=0 OK=0 REASON="unexpected failure after start"
contain() {
  local rc=$?
  [[ $OK == 1 || $STARTED == 0 ]] && return
  trap - EXIT
  echo "STOP: $REASON"
  local known=1
  if ! $SYSTEMCTL stop chatgpt-plan-bridge.service; then echo "CONTAINMENT UNKNOWN: systemctl stop failed"; known=0; fi
  if [[ $known == 1 && $($SYSTEMCTL is-active chatgpt-plan-bridge.service || true) != inactive ]]; then echo "CONTAINMENT UNKNOWN: unit not inactive after stop"; known=0; fi
  if [[ $known == 1 ]] && ! no_bridge_process; then echo "CONTAINMENT UNKNOWN: a cpbridge process remains, or the process list could not be read"; known=0; fi
  [[ $known == 1 ]] && echo "contained: unit inactive, no cpbridge process"
  echo "ledger rows written since start (what that process may have handled):"; tail -n +$((LINES + 1)) "$LEDGER" || echo "(ledger unreadable)"
  exit $(( rc == 0 ? 1 : rc ))
}
fail() { REASON=$1; exit 1; }
trap contain EXIT

step "start $SHA ($MODE)"
STARTED=1   # set before the call: a partial enable/start must still be contained
$SYSTEMCTL enable --now chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.timer || fail "enable --now failed"
PID=0
for _ in $(seq 1 20); do PID=$($SYSTEMCTL show -p MainPID --value chatgpt-plan-bridge.service || echo 0); [[ $PID =~ ^[1-9][0-9]*$ ]] && break; PID=0; $SLEEP 0.5; done
[[ $PID != 0 ]] || fail "no main PID"
# systemd reports MainPID at fork; while the executor sets up the sandbox, /proc/<pid>/cmdline shows a placeholder such as
# "(bun)" until the real exec (reproduced S603 deploy 03:56Z). Wait for the exec, then bind exactly once.
for _ in $(seq 1 40); do c=$(tr '\0' ' ' < "$PROC/$PID/cmdline" 2>/dev/null || true); [[ -n $c && $c != \(* ]] && break; $SLEEP 0.25; done
$BIND "$PID" "$OPTROOT" "$SHA" "$E/config.json" "$PIN" "$SWAP" || fail "the running process does not bind to $SHA"
echo "bound: pid $PID runs $OPTROOT/$SHA (script, start after swap, interpreter, config)"

resp=""
for _ in $(seq 1 20); do
  resp=$(printf 'header = "Authorization: Bearer %s"\n' "$(< "$E/caller.secret")" | $CURL -sS -K - -w '\n%{http_code}' "http://127.0.0.1:$PORT/v1/bridge/status" 2>/dev/null) && break
  resp=""; $SLEEP 0.5
done
[[ -n $resp ]] || fail "status unreachable"
code=${resp##*$'\n'} body=${resp%$'\n'*}
[[ $code == 200 ]] || fail "status=$code (want 200)"
printf '%s' "$body" | python3 -I "$HERE/status_check.py" "$MODE" "$OPTROOT/$SHA" "$PIN" || fail "status or startup identity does not bind"
OK=1
step "live on $SHA"
