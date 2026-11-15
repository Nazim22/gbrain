#!/bin/bash
# Offline tests of the paid delivery pieces (GBRAIN-S593): init_spend.py, canary_check.py, and that the PREVIOUS plan bundle
# keeps a spend map it does not know about. No network, no service, no live path. Usage: paid_delivery.test.sh [<old-worktree>]
set -u
D=$(cd "$(dirname "$0")" && pwd); OLDW=${1:-}; FAILS=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
expect() { if [[ $2 == "$3" ]]; then echo "OK   $1"; else echo "FAIL $1 (got $2, want $3)"; FAILS=$((FAILS+1)); fi; }
C='{"hour_start":1794707476123,"hour":79,"day_start":1794628370729,"day":596}'
init() { python3 -I "$D/init_spend.py" "$T/c.json" "$T/ledger" "$T/base.json" > "$T/out" 2>&1; echo $?; }
base() { python3 -I -c 'import hashlib,json,sys; h=lambda p: hashlib.sha256(open(p,"rb").read()).hexdigest(); print(json.dumps({"counters_sha256":h(sys.argv[1]),"ledger_sha256":h(sys.argv[2])}))' "$T/c.json" "$T/ledger" > "$T/base.json"; }
fresh() { rm -f "$T"/c.json* "$T/ledger" "$T/base.json" "$T/real.json"; printf '%s' "${1:-$C}" > "$T/c.json"; echo '{"id":"plan-row","status":200}' > "$T/ledger"; base; }

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
fresh; rm "$T/ledger"; before=$(sha256sum "$T/c.json"); expect "missing ledger refused" "$(init)" 1; expect "  bytes unchanged" "$(sha256sum "$T/c.json")" "$before"
fresh; rm "$T/base.json"; before=$(sha256sum "$T/c.json"); expect "no stopped pre-paid baseline refused" "$(init)" 1; expect "  bytes unchanged" "$(sha256sum "$T/c.json")" "$before"
fresh; printf '%s' '{"hour_start":1794707476123,"hour":80,"day_start":1794628370729,"day":597}' > "$T/c.json"; expect "counters changed since the baseline refused" "$(init)" 1
fresh; echo '{"id":"later","status":502}' >> "$T/ledger"; before=$(sha256sum "$T/c.json"); expect "ledger changed since the baseline refused" "$(init)" 1; expect "  bytes unchanged" "$(sha256sum "$T/c.json")" "$before"
fresh; rm "$T/c.json"; expect "missing counters refused (never created)" "$(init)" 1; expect "  still missing" "$([[ -e $T/c.json ]] && echo yes || echo no)" no
fresh; mv "$T/c.json" "$T/real.json"; ln -s "$T/real.json" "$T/c.json"; expect "linked counters refused" "$(init)" 1
fresh; echo '{"id":"x","status":200,"reserved_micro":274500}' > "$T/ledger"; base; before=$(sha256sum "$T/c.json"); expect "earlier paid use without a spend map refused (not recreated empty)" "$(init)" 1; expect "  bytes unchanged" "$(sha256sum "$T/c.json")" "$before"

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
# the reviewer's two false-PASS counterexamples, and a judge that cannot read its inputs
scene '{}' "$(row rid 200 "$GOOD" true 211 | sed 's/"spend_day":"2026-11-15",//')"; echo '{"spend":{}}' > "$S/counters.json"; expect "row without an admission day + bare post counters is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211 | sed 's/"spend_day":"2026-11-15"/"spend_day":"2026-02-30"/')"; expect "impossible admission day is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; echo '{"hour_start":1,"hour":-123,"day_start":1,"day":2,"spend":{"2026-11-14":500,"2026-11-15":211}}' > "$S/counters.json"; expect "negative call counter after the call is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; echo '{"hour_start":1,"hour":1,"day_start":1,"day":1}' > "$T/pre.json"; expect "pre-counters without a spend map is STOP" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; echo 'not json' > "$S/counters.json"; expect "unreadable post counters is STOP" "$(chk)" 1; expect "  and a STOP receipt is still written" "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["verdict"])' "$T/receipt.json")" STOP
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; echo 'not json' > "$T/resp.json"; expect "unreadable response is STOP with a receipt" "$(chk)" 1
scene '{"2026-11-14":500,"2026-11-15":211}' "$(row rid 200 "$GOOD" true 211)"; echo 'broken' >> "$S/requests.jsonl"; expect "unparseable ledger tail is STOP with a receipt" "$(chk)" 1

# canary cleanup (canary_lib.sh) with stand-in commands: the fence goes only after the stop is proven
clean() {   # <is-active answer> <pgrep exit> <incoming rc>  -> prints "rc=<n> fence=<removed|kept> cfg=<removed|kept>"
  ( cd "$T"; echo x > canary.json; rm -f fence.removed
    cat > sysctl.stub <<EOS
#!/bin/bash
[[ \$1 == is-active ]] && { echo $1; exit 0; }; exit ${4:-0}
EOS
    printf '#!/bin/bash\nexit %s\n' "$2" > pgrep.stub; printf '#!/bin/bash\n[[ %s == 0 ]] || exit %s\ntouch %s/fence.removed\n' "${EGRESS_RC:-0}" "${EGRESS_RC:-0}" "$T" > egress.stub; printf '#!/bin/bash\nexit 0\n' > nop.stub; chmod +x *.stub
    SYSTEMCTL="$T/sysctl.stub" PGREP="$T/pgrep.stub" NFT="$T/nop.stub" SLEEP="$T/nop.stub"; source "$D/canary_lib.sh"
    canary_cleanup "$3" unit "$T/egress.stub" "$T/canary.json" "$T" > "$T/clean.out" 2>&1; rc=$?
    echo "rc=$rc fence=$([[ -e fence.removed ]] && echo removed || echo kept) cfg=$([[ -e canary.json ]] && echo kept || echo removed)" )
}
expect "stopped + no process + success: fence and config removed, rc kept 0" "$(clean inactive 1 0)" "rc=0 fence=removed cfg=removed"
expect "stopped + no process + earlier failure: removed, rc kept" "$(clean inactive 1 7)" "rc=7 fence=removed cfg=removed"
expect "unit still active: fence and config KEPT, rc forced non-zero" "$(clean active 1 0)" "rc=1 fence=kept cfg=kept"
expect "a cpbridge process survives: fence and config KEPT, rc forced non-zero" "$(clean inactive 0 0)" "rc=1 fence=kept cfg=kept"
expect "failed unit with a survivor and earlier failure: KEPT, rc kept" "$(clean failed 0 3)" "rc=3 fence=kept cfg=kept"
expect "unknown unit state: KEPT" "$(clean unknown 1 0)" "rc=1 fence=kept cfg=kept"
for prc in 2 3 127; do expect "process list unreadable (pgrep exit $prc): KEPT, rc forced non-zero" "$(clean inactive $prc 0)" "rc=1 fence=kept cfg=kept"; done
expect "stop proven but fence removal fails: rc forced non-zero, config kept" "$(EGRESS_RC=42 clean inactive 1 0)" "rc=1 fence=kept cfg=kept"
expect "  and the output does not claim removal" "$(grep -c 'egress fence removed' "$T/clean.out")" 0
expect "  and it says teardown failed" "$(grep -c 'TEARDOWN FAILED' "$T/clean.out")" 1
expect "stop proven, removal fails, earlier failure: rc kept" "$(EGRESS_RC=42 clean inactive 1 5)" "rc=5 fence=kept cfg=kept"

# baseline_stage_ok: only a baseline that passed every bundle/runtime/helper/unit check and ended at config.json or VERIFIED
stage() { ( source "$D/canary_lib.sh"; baseline_stage_ok "$T/base.txt" >/dev/null 2>&1; echo $? ); }
OKS='ok  installed dir /opt/x
ok  bridge.js (fresh bundle of the reviewed tools)  aaaa
ok  bun runtime  bbbb
ok  detector_check.py  cccc
ok  egress.sh  dddd
ok  chatgpt-plan-bridge.service  eeee
ok  chatgpt-plan-bridge-egress.service  ffff
ok  chatgpt-plan-bridge-egress.timer  gggg'
printf '%s\nREFUSE: config.json differs from install.sh for /opt/x: [%s]\n' "$OKS" "'halt_on', 'leak'" > "$T/base.txt"; expect "baseline that stops at config.json is accepted" "$(stage)" 0
printf '%s\nok  config.json == install.sh heredoc\nok  redactor.py pinned\nVERIFIED: the installed bridge is the reviewed bytes\n' "$OKS" > "$T/base.txt"; expect "fully verified baseline is accepted" "$(stage)" 0
printf 'ok  installed dir /opt/x\nREFUSE: bridge.js (fresh bundle of the reviewed tools) differs from the reviewed bytes (/opt/x/bridge.js)\n' > "$T/base.txt"; expect "baseline that stops at the bundle is refused" "$(stage)" 1
printf '%s\n' "$OKS" | grep -v egress.timer > "$T/base.txt"; echo "REFUSE: config.json differs from install.sh for /opt/x: ['halt_on']" >> "$T/base.txt"; expect "baseline missing a unit check is refused" "$(stage)" 1
printf '%s\n' "$OKS" > "$T/base.txt"; expect "baseline with neither a verdict nor the config refusal is refused" "$(stage)" 1
printf 'REFUSE: current is not a symlink\n' > "$T/base.txt"; expect "early refusal is refused" "$(stage)" 1
: > "$T/base.txt"; expect "empty baseline is refused" "$(stage)" 1
( source "$D/canary_lib.sh"; for c in 0 1 2 127; do printf '#!/bin/bash\nexit %s\n' $c > "$T/pg.stub"; chmod +x "$T/pg.stub"; PGREP="$T/pg.stub"; no_bridge_process; echo -n "$c:$? "; done ) > "$T/nbp.out"; expect "no_bridge_process: only pgrep exit 1 proves none" "$(cat "$T/nbp.out")" "0:1 1:0 2:2 127:2 "

# The previous plan bundle's Limits must keep a spend map through its own admissions (rollback keeps paid accounting).
if [[ -n $OLDW ]]; then
  echo '{"hour_start":1794707476123,"hour":79,"day_start":1794628370729,"day":596,"spend":{"2026-11-15":211,"2026-11-14":5}}' > "$T/old.json"
  out=$(cd "$OLDW" && bun -e 'const {Limits}=await import("./tools/chatgpt-plan-bridge/limits.ts"); const l=new Limits(process.argv[1],{per_hour:600,per_day:6000,concurrency:2},()=>1794707476123+1000); const a=l.admit(); a.release(); const b=l.admit(); console.log(a.ok&&b.ok)' "$T/old.json" 2>&1)
  expect "previous plan bundle admits on paid-initialised counters" "$out" true
  expect "  and keeps the spend map exactly" "$(python3 -I -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["spend"]=={"2026-11-15":211,"2026-11-14":5} and d["hour"]==81)' "$T/old.json")" True
else echo "SKIP previous-bundle check (no old worktree given)"; fi
echo "RESULT: $FAILS failure(s)"; exit $FAILS
