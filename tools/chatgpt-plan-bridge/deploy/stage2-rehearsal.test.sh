#!/bin/bash
# Stage-2 scratch end-to-end rehearsal (Pebble whole-object HOLD de75ce3d): the runbook's own commands, CANARY_STAGE2=1,
# against a gbrain_s552_* scratch brain, a scratch copy of 12 corpus parts, a scratch gbrain home and a TEST-ONLY stub
# bridge (stub_bridge.py; no live model call). Live services are never touched (canary/state_check dry-run modes).
#  batch 1  normal: slice -> sessions/eligible checks -> rename -> E V B C D F pre-open G post-run H date_gates I K S
#           resume post-resume (plus refusals: G without members, members not bound, bytes changed, session grew)
#  batch 2  zero-atom: stub returns no atoms -> native tombstones -> date_gates PASS -> S completes on gates only
#  batch 3  STOP cleanup: G fault after OPEN -> admission closed + corpus key absent (post-run OK) -> rollback on decision
#  batch 4  earlier KEPT batch tampered in the scratch DB -> date_gates FAIL (10) -> S refuses -> rollback on decision
# Usage: stage2-rehearsal.test.sh <scratch-db gbrain_s552_*> <source scratch gbrain home> <out dir> <plan run.manifest>
set -u
DB=$1 SRCHOME=$2 OUT=$3 PLAN=$4
[[ $DB == gbrain_s552_* ]] || { echo "REFUSE: scratch DB only"; exit 1; }
W=$(cd "$(dirname "$0")/../../.." && pwd); C="$W/tools/chatgpt-plan-bridge/deploy"; O="$W/tools/chatgpt-plan-bridge/ops"; HEAD=$(git -C "$W" rev-parse HEAD)
mkdir -p "$OUT"; [[ -z $(ls -A "$OUT") ]] || { echo "REFUSE: $OUT must be empty"; exit 1; }
RUN=$OUT/run CAN=$OUT/canary; mkdir -p "$OUT/corpus" "$OUT/ctl" "$RUN" "$CAN"
cp -a "$SRCHOME" "$OUT/home"
head -c 24 /dev/urandom | base64 > "$OUT/secret"; chmod 600 "$OUT/secret"; : > "$OUT/ledger.jsonl"; echo ok > "$OUT/ctl/mode"
sed -n '40,51p' "$PLAN" | cut -f3 | while read -r p; do cp -p "$p" "$OUT/corpus/"; done
PORT=$((20000 + RANDOM % 20000))
python3 -I "$C/stub_bridge.py" "$PORT" "$OUT/secret" "$OUT/ledger.jsonl" "$OUT/ctl" & STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT; sleep 1
export CANARY_DRYRUN=1 CANARY_STAGE2=1 CANARY_DB=$DB CANARY_DIR=$CAN GBRAIN_HOME=$OUT/home CANARY_PORT=$PORT CANARY_SECRET=$OUT/secret
export CANARY_LEDGER=$OUT/ledger.jsonl CANARY_CORPUS=$OUT/corpus CANARY_RENAMES=$RUN/renames.tsv CANARY_SESSIONS=$RUN/run.manifest.sessions
export STATE_DRYRUN=1 STATE_DB=$DB STATE_DIR=$CAN STATE_CFG=$OUT/home/.gbrain/config.json STATE_PORT=$PORT STATE_SECRET=$OUT/secret
source /root/.gbrain/pg.env; export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE=$DB PGPASSWORD="$PASS" DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/$DB"
: > "$RUN/renames.tsv"
FAILS=0
cs() { bash "$C/canary.sh" "$1" "$HEAD" 2>&1; }
st() { bash "$C/state_check.sh" "$1" 2>&1; }
expect() { if [[ "$2" == *"$3"* ]]; then echo "OK   $1"; else echo "FAIL $1: wanted '$3' in: $(echo "$2" | tail -12)"; FAILS=$((FAILS+1)); fi; }
attempt() { cat "$CAN/ATTEMPT"; }
labels() { python3 -I - "$1" <<'PY'
import json, sys
r = sys.argv[1]; key = json.load(open(f'{r}/key.json'))
for f in ('labels-r1.jsonl', 'labels-r2-pebble.jsonl'):
    open(f'{r}/{f}', 'w').write(''.join(json.dumps({'bid': b, 'part': v['part'], 'fidelity': 'supported', 'generic': False,
        'claim_key': b, 'evidence': '', 'reason': 'rehearsal'}) + '\n' for b, v in key.items()))
PY
}
# Step 0 (read-only freeze over the scratch corpus)
(cd "$O" && bun inventory.ts "$OUT/corpus" "$RUN/freeze-inventory" "$RUN/renames.tsv" > "$RUN/freeze-inventory.out")
python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));[print(r['hash16']+'\t'+r['path']) for r in d['rows'] if r['class']=='missing']" "$RUN/freeze-inventory/inventory.json" > "$RUN/eligible.manifest"
out=$(python3 -I "$O/date_parts.py" plan "$RUN/eligible.manifest" "$RUN/run.manifest" "$RUN/refused.tsv" 2>&1); expect "step 0 freeze plans the scratch parts" "$out" "plan: 12 dated"
slice() {   # runbook 2.1-2.3 for rows a..b: slice, session growth, eligibility with both aliases, rename, batch manifest
  local n=$1 a=$2 b=$3 M=$RUN/batch-$1.members
  sed -n "${a},${b}p" "$RUN/run.manifest" > "$M"
  python3 -I "$O/date_parts.py" sessions-check "$M" "$CANARY_SESSIONS" >/dev/null || { echo "slice $n: sessions-check failed"; return 1; }
  (cd "$O" && bun inventory.ts "$OUT/corpus" "$RUN/elig-$n" "$RUN/renames.tsv" > "$RUN/elig-$n.out")
  python3 -I "$O/date_parts.py" eligible-check "$M" "$RUN/elig-$n/inventory.json" >/dev/null || { echo "slice $n: eligible-check failed"; return 1; }
  python3 -I "$O/date_parts.py" rename "$M" 1 "$(wc -l < "$M")" "$RUN/renames.tsv" --apply >/dev/null || return 1
  awk -F'\t' '{print $1"\t"$4}' "$M" > "$RUN/batch-$n.manifest"; echo "slice $n ok"
}
prepare() {   # runbook 2.4-2.7: V B C D E F (route back to Luna after a rollback via D)
  local n=$1; echo "${2:-ok}" > "$OUT/ctl/mode"
  cs V >/dev/null; cs B >/dev/null; cs C >/dev/null; cs D >/dev/null
  CANARY_MANIFEST=$RUN/batch-$n.manifest cs E; cs F >/dev/null
}

echo "##### batch 1: normal"
out=$(slice 1 1 3);                      expect "slice 1: sessions/eligible checks, rename, manifest" "$out" "slice 1 ok"
out=$(prepare 1);                         expect "E takes the frozen slice" "$out" "attempt: $CAN/attempt-"
A1=$(attempt)
out=$(cs G);                              expect "G refuses without CANARY_MEMBERS (stage 2)" "$out" "stage 2 needs CANARY_MEMBERS"
out=$(CANARY_MEMBERS=$RUN/batch-2.members cs G 2>&1); expect "G refuses members that do not bind the manifest" "$out" "REFUSE"
cp -p "$CANARY_SESSIONS" "$RUN/sessions.bak"; chmod u+w "$CANARY_SESSIONS"
sid=$(head -1 "$RUN/batch-1.members" | cut -f3 | sed -E 's/.*session-([0-9a-f-]{36}).*/\1/'); sed -i "s/^$sid\t[0-9]*/$sid\t1/" "$CANARY_SESSIONS"
out=$(CANARY_MEMBERS=$RUN/batch-1.members cs G); expect "G refuses before OPEN when a member's session grew" "$out" "session grew since the freeze"
cp -p "$RUN/sessions.bak" "$CANARY_SESSIONS"
f1=$(head -1 "$RUN/batch-1.members" | cut -f4); cp -p "$f1" "$RUN/f1.bak"; echo "rewritten" >> "$f1"
out=$(CANARY_MEMBERS=$RUN/batch-1.members cs G); expect "G refuses before OPEN when a member's bytes changed" "$out" "bytes changed since the freeze"
cp -p "$RUN/f1.bak" "$f1"
expect "admission still closed after the refusals" "$(st post-run)" "STATE post-run: OK"
out=$(st pre-open);                       expect "pre-open: closed, corpus key absent, latch clear, route Luna" "$out" "STATE pre-open: OK"
out=$(CANARY_MEMBERS=$RUN/batch-1.members cs G); expect "G runs (corpus key only OPEN..CLOSED)" "$out" "dream rc=0"
out=$(st post-run);                       expect "post-run: admission closed and corpus key absent (db+file)" "$out" "STATE post-run: OK"
cs H >/dev/null
out=$(python3 -I "$O/date_gates.py" "$A1" "$RUN/batch-1.members" "$CAN/stage2-kept" 2>&1); expect "date_gates PASS (3 dated atoms, outcomes consistent)" "$out" "GATES: PASS"
cs I >/dev/null; out=$(cs K); expect "K builds the kit" "$out" "kit/"; labels "$A1/rating"
out=$(CANARY_MEMBERS=$RUN/batch-1.members cs S); expect "S PASS (both raters, gates.ok bound)" "$out" "ACCEPTANCE (rating): PASS"
out=$(CANARY_MEMBERS=$RUN/batch-1.members cs resume); expect "resume records the kept batch" "$out" "kept record"
out=$(st post-resume);                    expect "post-resume: closed, corpus key absent" "$out" "STATE post-resume: OK"

echo "##### batch 2: zero-atom"
out=$(slice 2 4 6); expect "slice 2" "$out" "slice 2 ok"
out=$(prepare 2 empty); expect "E batch 2" "$out" "attempt: $CAN/attempt-"; A2=$(attempt)
out=$(CANARY_MEMBERS=$RUN/batch-2.members cs G); expect "G runs (stub returns no atoms)" "$out" "dream rc=0"
cs H >/dev/null
out=$(python3 -I "$O/date_gates.py" "$A2" "$RUN/batch-2.members" "$CAN/stage2-kept" 2>&1); expect "date_gates PASS on native zero-atom tombstones" "$out" "zero-atom tombstone"
expect "date_gates exit/receipt" "$out" "GATES: PASS"
cs I >/dev/null; cs K >/dev/null
out=$(CANARY_MEMBERS=$RUN/batch-2.members cs S); expect "S completes a zero-atom batch on the gates alone" "$out" "zero-atom batch, gates PASS"
out=$(CANARY_MEMBERS=$RUN/batch-2.members cs resume); expect "resume after a zero-atom batch" "$out" "kept record"

echo "##### batch 3: STOP cleanup after OPEN"
out=$(slice 3 7 9); expect "slice 3" "$out" "slice 3 ok"
out=$(prepare 3); expect "E batch 3" "$out" "attempt: $CAN/attempt-"
out=$(CANARY_DRYRUN_FAULT=dream-exit CANARY_MEMBERS=$RUN/batch-3.members cs G); expect "G with a failure after OPEN stops" "$out" "STOP: dream exited 1"
out=$(st post-run);                       expect "STOP cleanup: admission closed + corpus key absent (db+file)" "$out" "STATE post-run: OK"
out=$(cs rollback);                       expect "rollback on decision verifies DONE" "$out" '"verdict":"DONE"'
out=$(st post-rollback);                  expect "post-rollback: closed, corpus absent, route Gemma" "$out" "STATE post-rollback: OK"

echo "##### batch 4: an earlier KEPT batch changed"
out=$(slice 4 10 12); expect "slice 4" "$out" "slice 4 ok"
out=$(prepare 4); expect "E batch 4" "$out" "attempt: $CAN/attempt-"; A4=$(attempt)
out=$(CANARY_MEMBERS=$RUN/batch-4.members cs G); expect "G runs batch 4" "$out" "dream rc=0"
cs H >/dev/null
kid=$(python3 -I -c "import json,glob;print(json.load(open(sorted(glob.glob('$CAN/stage2-kept/*.json'))[0]))[0]['id'])")
psql -XAt -c "update pages set content_hash = 'rehearsal-tamper' where id = $kid" >/dev/null
out=$(python3 -I "$O/date_gates.py" "$A4" "$RUN/batch-4.members" "$CAN/stage2-kept" 2>&1); rc=$?
expect "date_gates FAIL when an earlier kept batch changed" "$out" "earlier kept batch changed"; expect "that FAIL is exit 10 (complete evidence)" "$rc" "10"
cs I >/dev/null; cs K >/dev/null; labels "$A4/rating"
out=$(CANARY_MEMBERS=$RUN/batch-4.members cs S); expect "S refuses without a bound gates.ok" "$out" "no gates.ok"
out=$(cs rollback); expect "rollback on decision (batch 4) verifies DONE" "$out" '"verdict":"DONE"'
echo "RESULT: $FAILS failure(s)"; exit $FAILS
