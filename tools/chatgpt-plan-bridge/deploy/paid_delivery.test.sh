#!/bin/bash
# Offline tests of the paid delivery pieces (GBRAIN-S593): init_spend.py, canary_check.py, and that the PREVIOUS plan bundle
# keeps a spend map it does not know about. No network, no service, no live path. Usage: paid_delivery.test.sh [<old-worktree>]
set -u
D=$(cd "$(dirname "$0")" && pwd); OLDW=${1:-}; FAILS=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
expect() { if [[ $2 == "$3" ]]; then echo "OK   $1"; else echo "FAIL $1 (got $2, want $3)"; FAILS=$((FAILS+1)); fi; }
C='{"hour_start":1794707476123,"hour":79,"day_start":1794628370729,"day":596}'
init() { python3 -I "$D/init_spend.py" "$T/c.json" "$T/ledger" > "$T/out" 2>&1; echo $?; }
fresh() { rm -f "$T"/c.json* "$T/ledger"; printf '%s' "${1:-$C}" > "$T/c.json"; : > "$T/ledger"; }

fresh; expect "valid plan counters are initialised" "$(init)" 0
expect "  spend is {} and every counter kept" "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))=={"hour_start":1794707476123,"hour":79,"day_start":1794628370729,"day":596,"spend":{}})' "$T/c.json")" True
before=$(sha256sum "$T/c.json"); expect "re-run is a no-op" "$(init)" 0; expect "  bytes unchanged on re-run" "$(sha256sum "$T/c.json")" "$before"
fresh '{"hour_start":1,"hour":0,"day_start":1,"day":0,"extra":{"k":[1,2]}}'; expect "unknown keys survive" "$(init)" 0
expect "  extra kept" "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["extra"])' "$T/c.json")" "{'k': [1, 2]}"
fresh '{"hour_start":1,"hour":0,"day_start":1,"day":0,"spend":{"2026-11-15":211}}'; before=$(sha256sum "$T/c.json"); expect "existing spend accepted" "$(init)" 0; expect "  and left byte-identical" "$(sha256sum "$T/c.json")" "$before"
for bad in '{not json' '[]' '{"hour_start":1,"hour":0,"day_start":1}' '{"hour_start":1,"hour":-1,"day_start":1,"day":0}' '{"hour_start":1,"hour":0.5,"day_start":1,"day":0}' \
  '{"hour_start":1,"hour":0,"day_start":1,"day":0,"spend":[]}' '{"hour_start":1,"hour":0,"day_start":1,"day":0,"spend":{"2026-02-30":1}}' '{"hour_start":1,"hour":0,"day_start":1,"day":0,"spend":{"2026-11-15":-1}}' \
  '{"hour_start":1,"hour":0,"day_start":1,"day":0,"spend":{"2026-11-15":1.5}}' '{"hour":0,"hour":1,"hour_start":1,"day_start":1,"day":0}' '{"hour_start":1,"hour":0,"day_start":1,"day":0,"spend":{"2026-11-15":true}}'; do
  fresh "$bad"; before=$(sha256sum "$T/c.json"); expect "refused: $bad" "$(init)" 1; expect "  bytes unchanged" "$(sha256sum "$T/c.json")" "$before"
done
fresh; rm "$T/c.json"; expect "missing counters refused (never created)" "$(init)" 1; expect "  still missing" "$([[ -e $T/c.json ]] && echo yes || echo no)" no
fresh; mv "$T/c.json" "$T/real.json"; ln -s "$T/real.json" "$T/c.json"; expect "linked counters refused" "$(init)" 1
fresh; echo '{"id":"x","status":200,"reserved_micro":274500}' > "$T/ledger"; before=$(sha256sum "$T/c.json"); expect "earlier paid use without a spend map refused (not recreated empty)" "$(init)" 1; expect "  bytes unchanged" "$(sha256sum "$T/c.json")" "$before"

# canary_check.py on a synthetic state dir
S="$T/state"; mkdir -p "$S"
cfg() { cat > "$T/cfg.json" <<EOF
{"state_dir":"$S","routes":{"gpt-6-luna@medium":{"max_input_tokens":1050000,"max_output_tokens":16000,"price_micro_per_mtok":{"input":250000,"output":750000}}}}
EOF
}; cfg
row() { echo "{\"ts\":\"t\",\"id\":\"$1\",\"status\":$2,\"finish\":\"stop\",\"usage\":$3,\"reserved_micro\":274500,\"spend_day\":\"2026-11-15\",\"settled\":$4,\"settled_micro\":$5}"; }
scene() {   # <post-spend-json> <row-line...>
  rm -f "$S"/*; echo '{"old":1}' > "$S/requests.jsonl"; echo '{"hour_start":1,"hour":1,"day_start":1,"day":1,"spend":{"2026-11-14":500}}' > "$T/pre.json"
  echo "{\"hour_start\":1,\"hour\":2,\"day_start\":1,\"day\":2,\"spend\":$1}" > "$S/counters.json"; shift; for r in "$@"; do echo "$r" >> "$S/requests.jsonl"; done
  echo '{"choices":[{"finish_reason":"stop","message":{"content":"ready"}}]}' > "$T/resp.json"
}
chk() { python3 -I "$D/canary_check.py" "$T/cfg.json" "$T/pre.json" 1 "${1:-200}" "$T/resp.json" "${2-rid}" "$T/receipt.json" > "$T/out" 2>&1; echo $?; }
GOOD='{"input_tokens":817,"output_tokens":8}'
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; expect "canary PASS on a clean settled call" "$(chk)" 0
expect "  receipt says PASS" "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["verdict"])' "$T/receipt.json")" PASS
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; expect "HTTP 502 is STOP" "$(chk 502)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row other 200 "$GOOD" true 211)"; expect "row of another request id is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)" "$(row rid2 200 "$GOOD" true 211)"; expect "two new rows is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":274500}' "$(row rid 200 "$GOOD" false null)"; expect "unsettled (tier/usage) is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":210}' "$(row rid 200 "$GOOD" true 210)"; expect "settled amount not the recomputed cost is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":999}' "$(row rid 200 "$GOOD" true 211)"; expect "spend not pre + cost is STOP" "$(chk)" 1
scene '{"2026-11-14":499,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; expect "another day changed is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 '{"input_tokens":1050001,"output_tokens":8}' true 211)"; expect "usage over the maxima is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; echo '{"code":"budget_invariant"}' > "$S/halted.json"; expect "a halt latch is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; echo '{"choices":[{"finish_reason":"length","message":{"content":"re"}}]}' > "$T/resp.json"; expect "finish length is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; expect "missing request id is STOP" "$(chk 200 '')" 1

# The previous plan bundle's Limits must keep a spend map through its own admissions (rollback keeps paid accounting).
if [[ -n $OLDW ]]; then
  echo '{"hour_start":1794707476123,"hour":79,"day_start":1794628370729,"day":596,"spend":{"2026-11-15":211,"2026-11-14":5}}' > "$T/old.json"
  out=$(cd "$OLDW" && bun -e 'const {Limits}=await import("./tools/chatgpt-plan-bridge/limits.ts"); const l=new Limits(process.argv[1],{per_hour:600,per_day:6000,concurrency:2},()=>1794707476123+1000); const a=l.admit(); a.release(); const b=l.admit(); console.log(a.ok&&b.ok)' "$T/old.json" 2>&1)
  expect "previous plan bundle admits on paid-initialised counters" "$out" true
  expect "  and keeps the spend map exactly" "$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["spend"]=={"2026-11-15":211,"2026-11-14":5} and d["hour"]==81)' "$T/old.json")" True
else echo "SKIP previous-bundle check (no old worktree given)"; fi
echo "RESULT: $FAILS failure(s)"; exit $FAILS
