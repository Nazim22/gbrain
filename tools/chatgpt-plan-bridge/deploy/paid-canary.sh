#!/bin/bash
# The ONE paid canary call (GBRAIN-S593, PAID-RUNBOOK.md step 3). Root, attended. Preconditions are checked, not assumed:
# install.sh paid has run (bridge stopped, verified). It starts the INSTALLED paid bundle as the bridge user in a transient
# unit with the service's own sandbox, on a canary port, with a config that is the installed one except for that port;
# sends exactly ONE request; stops it; judges the result from the ledger and counters (canary_check.py).
# Whatever the outcome the bridge is left STOPPED, nothing is retried, cleared or reset. Worst case kept: one reservation.
# A second run refuses: the attempt marker is removed only by a new reviewed decision.
# Attended premise, not enforced by the machine: no other client calls the bridge during the run. The canary port and
# the transient unit keep ordinary callers away (they use the live port), but anyone holding the caller secret could
# reach port 18796 on loopback; an extra completed request is detected (the judge needs exactly one new ledger row).
# Usage: paid-canary.sh <bridge-worktree> <reviewed-head-sha> <evidence-dir>
set -euo pipefail
W=$1 WANT=$2 OUT=$3
SRC=$W/tools/chatgpt-plan-bridge; E=/etc/chatgpt-plan-bridge; S=/srv/chatgpt-plan-bridge/state; OPT=/opt/chatgpt-plan-bridge/$WANT
CPORT=18796 UNIT=cpbridge-paid-canary
step() { echo "== $(date -u +%FT%TZ) $*"; }
source "$SRC/deploy/canary_lib.sh"
[[ $(git -C "$W" rev-parse HEAD) == "$WANT" && -z $(git -C "$W" status --porcelain) ]] || { echo "REFUSE: $W is not clean at $WANT"; exit 1; }
[[ $(readlink /opt/chatgpt-plan-bridge/current) == "$OPT" ]] || { echo "REFUSE: current is not $OPT"; exit 1; }
[[ -d $OUT && -z $(ls -A "$OUT") ]] || { echo "REFUSE: evidence dir must exist and be empty"; exit 1; }
chmod 0700 "$OUT"

step "preconditions"
python3 -I "$SRC/deploy/verify_install.py" "$W" paid
[[ $(systemctl is-active chatgpt-plan-bridge.service || true) == inactive ]] || { echo "REFUSE: the live bridge unit is not inactive"; exit 1; }
[[ $(systemctl is-active $UNIT.service || true) == inactive ]] || { echo "REFUSE: a canary unit already exists"; exit 1; }
no_bridge_process || { echo "REFUSE: a cpbridge process is running, or the process list could not be read"; exit 1; }
[[ ! -e $S/halted.json && ! -L $S/halted.json ]] || { echo "REFUSE: a halt latch is present"; exit 1; }
( set -o noclobber; date -u +%FT%TZ > "$E/paid-canary.attempted" ) 2>/dev/null || { echo "REFUSE: a paid canary was already attempted ($(cat "$E/paid-canary.attempted")); a second needs a new reviewed decision"; exit 1; }

step "canary config = installed paid config with ONLY the port changed"
python3 -I - "$E/config.json" "$E/paid-canary.json" $CPORT <<'PY'
import json, os, sys
src, dst, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
c = json.load(open(src)); d = dict(c); d['port'] = port
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
os.write(fd, json.dumps(d).encode()); os.close(fd)
back = json.load(open(dst))
assert {k: v for k, v in back.items() if k != 'port'} == {k: v for k, v in c.items() if k != 'port'} and back['port'] == port != c['port']
print('ok  only "port" differs:', c['port'], '->', port)
PY
chown root:cpbridge "$E/paid-canary.json"; chmod 0640 "$E/paid-canary.json"

install -m 0600 "$S/counters.json" "$OUT/pre-counters.json"
PRE_LINES=$(wc -l < "$S/requests.jsonl")
echo "pre: ledger lines $PRE_LINES, counters $(cat "$OUT/pre-counters.json")"

cleanup() { local rc=$?; set +e; canary_cleanup "$rc" "$UNIT" "$OPT/egress.sh" "$E/paid-canary.json" "$OUT"; exit $?; }
trap cleanup EXIT

step "egress fence for the canary port, then the installed bundle as cpbridge with the service's own sandbox"
CPBRIDGE_PORT=$CPORT "$OPT/egress.sh" add
# Every [Service] property of the installed unit except how it is started/stopped/restarted.
mapfile -t PROPS < <(awk '/^\[Service\]/{s=1;next} /^\[/{s=0} s && /^[A-Za-z]+=/ && !/^(Type|ExecStartPre|ExecStart|ExecStopPost|Restart|RestartSec)=/{print "--property=" $0}' /etc/systemd/system/chatgpt-plan-bridge.service)
printf '%s\n' "${PROPS[@]}" > "$OUT/canary-unit-properties.txt"
systemd-run --quiet --unit=$UNIT --collect "${PROPS[@]}" "$OPT/bun" "$OPT/bridge.js" "$E/paid-canary.json"
auth() { printf 'header = "Authorization: Bearer %s"\n' "$(< "$E/caller.secret")"; }
ok=0; for _ in $(seq 20); do code=$(auth | curl -sS -K - -o "$OUT/status.json" -w '%{http_code}' "http://127.0.0.1:$CPORT/v1/bridge/status" 2>/dev/null || true); [[ $code == 200 ]] && { ok=1; break; }; sleep 1; done
[[ $ok == 1 ]] || { echo "STOP: the canary bridge did not come up (no call was made)"; journalctl -u $UNIT --no-pager -n 20 | cut -c1-200; exit 1; }
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("halted") is None, "latch set"; assert d["routes"]==["gpt-6-luna@medium"], d["routes"]; print("canary bridge up, no latch, routes", d["routes"])' "$OUT/status.json"
[[ $(systemctl show -p User --value $UNIT.service) == cpbridge ]] || { echo "STOP: canary unit is not running as cpbridge (no call was made)"; exit 1; }

step "THE ONE CALL (no retry)"
printf '%s' '{"model":"gpt-6-luna@medium","messages":[{"role":"user","content":"Reply with exactly one word: ready"}]}' > "$OUT/request.json"
CODE=$(auth | curl -sS -K - --max-time 330 -D "$OUT/response-headers.txt" -o "$OUT/response.json" -w '%{http_code}' -H 'content-type: application/json' --data-binary @"$OUT/request.json" "http://127.0.0.1:$CPORT/v1/chat/completions" || echo "curl-failed")
REQ=$(awk 'tolower($1)=="x-bridge-request-id:"{print $2}' "$OUT/response-headers.txt" 2>/dev/null | tr -d '\r')
echo "http $CODE request id ${REQ:-none}"

step "stop the canary bridge, then judge"
canary_ceased "$UNIT" || { echo "STOP: the canary bridge could not be proven stopped; not judging"; exit 1; }
set +e
python3 -I "$SRC/deploy/canary_check.py" "$E/config.json" "$OUT/pre-counters.json" "$PRE_LINES" "$CODE" "$OUT/response.json" "${REQ:-}" "$OUT/receipt.json"
RC=$?; set -e
if [[ $RC == 0 ]]; then step "CANARY PASS. The bridge stays STOPPED until the receipt is accepted (PAID-RUNBOOK.md step 4)."
else step "CANARY STOP. No retry. Nothing is cleared or reset; the bridge stays STOPPED. Report the receipt."; fi
exit $RC
