#!/bin/bash
# Stage-2 scratch end-to-end rehearsal (Pebble whole-object HOLD de75ce3d): the runbook's own commands, CANARY_STAGE2=1,
# against a gbrain_s552_* scratch brain, a scratch copy of 12 corpus parts, a scratch gbrain home and a TEST-ONLY stub
# bridge (stub_bridge.py; no live model call). Live services are never touched (canary/state_check dry-run modes).
#  batch 1  normal: slice -> sessions/eligible checks -> rename -> E V B C D F pre-open G post-run H date_gates I K S
#           resume post-resume (plus refusals: G without members, members not bound, bytes changed, session grew)
#  batch 2  zero-atom: stub returns no atoms -> native tombstones -> date_gates PASS -> S completes on gates only
#           plus stale success: after a PASS, a post-OPEN source rewrite -> date_gates 10 removes gates.ok -> S refuses;
#           PASS -> unreadable evidence -> 2 removes gates.ok
#  batch 3  dream fails (rc 1) -> normal closure path -> post-run OK -> rollback on decision
#  batch 4  failure AFTER OPEN through G's EXIT trap -> both closures verified -> post-run OK -> rollback on decision
#  batch 5  same, with the admission close failing -> trap reports admission UNKNOWN, corpus key verified -> post-run
#           FAIL -> close by hand -> post-run OK -> rollback on decision
#  batch 6  earlier KEPT batch tampered in the scratch DB -> date_gates FAIL (10) -> S refuses -> rollback on decision
#  (Pebble consult 21:32Z, bounded retry R)  batch 2 also: R refuses on a PASSed attempt
#  batch 7  one malformed output -> gates 10 (failed pair only) -> R (exclusive retry.manifest) -> success -> H re-capture
#           -> date_gates PASS (retried 1, completed pairs preserved) -> R re-entry refused -> K S resume
#  batch 8  malformed again in R -> re-gates FAIL (10) -> R re-entry refused -> rollback on decision
#  batch 9  failure after R's OPEN -> trap verifies both closures -> post-run OK -> R re-entry refused -> rollback
#  (Pebble HOLD 22:37Z) batch 7 also: an earlier-kept change refuses R (nothing written); a zero-byte retry outcome -> gates 2
#  batch 10 R's dream leaves no outcome -> R STOPs (unknown outcome) -> re-entry refused -> gates 2 -> rollback
# Usage: stage2-rehearsal.test.sh <scratch-db gbrain_s552_*> <source scratch gbrain home> <out dir> <plan run.manifest>
set -u
DB=$1 SRCHOME=$2 OUT=$3 PLAN=$4
[[ $DB == gbrain_s552_* ]] || { echo "REFUSE: scratch DB only"; exit 1; }
W=$(cd "$(dirname "$0")/../../.." && pwd); C="$W/tools/chatgpt-plan-bridge/deploy"; O="$W/tools/chatgpt-plan-bridge/ops"; HEAD=$(git -C "$W" rev-parse HEAD)
mkdir -p "$OUT"; [[ -z $(ls -A "$OUT") ]] || { echo "REFUSE: $OUT must be empty"; exit 1; }
RUN=$OUT/run CAN=$OUT/canary; mkdir -p "$OUT/corpus" "$OUT/ctl" "$RUN" "$CAN"
cp -a "$SRCHOME" "$OUT/home"
head -c 24 /dev/urandom | base64 > "$OUT/secret"; chmod 600 "$OUT/secret"; : > "$OUT/ledger.jsonl"; echo ok > "$OUT/ctl/mode"
sed -n '40,69p' "$PLAN" | cut -f3 | while read -r p; do cp -p "$p" "$OUT/corpus/"; done
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
out=$(python3 -I "$O/date_parts.py" plan "$RUN/eligible.manifest" "$RUN/run.manifest" "$RUN/refused.tsv" 2>&1); expect "step 0 freeze plans the scratch parts" "$out" "plan: 30 dated"
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
# runbook order: K right after the PASS, from the unchanged sources
cs I >/dev/null; out=$(cs K); expect "K builds the kit" "$out" "kit/"; labels "$A1/rating"
f1=$(head -1 "$RUN/batch-1.members" | cut -f4); cp -p "$f1" "$RUN/f1b.bak"; echo "rewritten after OPEN" >> "$f1"
out=$(python3 -I "$O/date_gates.py" "$A1" "$RUN/batch-1.members" "$CAN/stage2-kept" 2>&1); rc=$?
expect "a post-OPEN source rewrite fails the gates (10)" "$rc:$out" "10:"; expect "...naming the rewritten member" "$out" "bytes changed since the freeze"
expect "the earlier PASS marker is gone" "$(ls "$A1/gates.ok" 2>&1)" "No such file"
out=$(CANARY_MEMBERS=$RUN/batch-1.members cs S); expect "S refuses on the stale (removed) marker" "$out" "no gates.ok"
cp -p "$RUN/f1b.bak" "$f1"
out=$(python3 -I "$O/date_gates.py" "$A1" "$RUN/batch-1.members" "$CAN/stage2-kept" 2>&1); expect "restored bytes: date_gates PASS again" "$out" "GATES: PASS"
mv "$A1/plan.json" "$A1/plan.json.away"; out=$(python3 -I "$O/date_gates.py" "$A1" "$RUN/batch-1.members" "$CAN/stage2-kept" 2>&1); rc=$?
expect "PASS -> unreadable evidence is exit 2" "$rc" "2"; expect "...and removes the marker" "$(ls "$A1/gates.ok" 2>&1)" "No such file"
mv "$A1/plan.json.away" "$A1/plan.json"; python3 -I "$O/date_gates.py" "$A1" "$RUN/batch-1.members" "$CAN/stage2-kept" >/dev/null
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
out=$(CANARY_MEMBERS=$RUN/batch-2.members cs R); expect "R refuses on a PASSed attempt (nothing written)" "$out" "not a bounded malformed-output retry"
expect "...and leaves no retry.manifest" "$(ls "$A2/retry.manifest" 2>&1)" "No such file"
cs I >/dev/null; cs K >/dev/null
out=$(CANARY_MEMBERS=$RUN/batch-2.members cs S); expect "S completes a zero-atom batch on the gates alone" "$out" "zero-atom batch, gates PASS"
out=$(CANARY_MEMBERS=$RUN/batch-2.members cs resume); expect "resume after a zero-atom batch" "$out" "kept record"

echo "##### batch 3: dream fails (normal closure path)"
out=$(slice 3 7 9); expect "slice 3" "$out" "slice 3 ok"
out=$(prepare 3); expect "E batch 3" "$out" "attempt: $CAN/attempt-"
out=$(CANARY_DRYRUN_FAULT=dream-exit CANARY_MEMBERS=$RUN/batch-3.members cs G); expect "G with a failure after OPEN stops" "$out" "STOP: dream exited 1"
out=$(st post-run);                       expect "STOP cleanup: admission closed + corpus key absent (db+file)" "$out" "STATE post-run: OK"
out=$(cs rollback);                       expect "rollback on decision verifies DONE" "$out" '"verdict":"DONE"'
out=$(st post-rollback);                  expect "post-rollback: closed, corpus absent, route Gemma" "$out" "STATE post-rollback: OK"

echo "##### batch 4: failure after OPEN through the EXIT trap"
out=$(slice 4 10 12); expect "slice 4" "$out" "slice 4 ok"
out=$(prepare 4); expect "E batch 4" "$out" "attempt: $CAN/attempt-"
out=$(CANARY_DRYRUN_FAULT=after-open CANARY_MEMBERS=$RUN/batch-4.members cs G); rc=$?
expect "the trap reports both closures verified" "$out" "admission closed: verified; corpus key absent (db+file): verified"; expect "...and keeps a failure status" "$([[ $rc != 0 ]] && echo nonzero)" "nonzero"
out=$(st post-run); expect "post-run OK after the trap" "$out" "STATE post-run: OK"
out=$(cs rollback); expect "rollback on decision (batch 4) verifies DONE" "$out" '"verdict":"DONE"'

echo "##### batch 5: failure after OPEN with the admission close failing"
out=$(slice 5 13 15); expect "slice 5" "$out" "slice 5 ok"
out=$(prepare 5); expect "E batch 5" "$out" "attempt: $CAN/attempt-"
out=$(CANARY_DRYRUN_FAULT=after-open-noadmclose CANARY_MEMBERS=$RUN/batch-5.members cs G); rc=$?
expect "the trap reports admission UNKNOWN and still removes the corpus key" "$out" "admission closed: UNKNOWN; corpus key absent (db+file): verified"
expect "...with a failure status" "$([[ $rc != 0 ]] && echo nonzero)" "nonzero"
out=$(st post-run); expect "post-run FAILs while admission is open" "$out" "STATE post-run: FAIL"
(cd "$W" && bun src/cli.ts config set cycle.extract_atoms.admit_hashes_file "$CAN/closed.manifest" >/dev/null 2>&1)   # runbook: close by hand
out=$(st post-run); expect "close by hand -> post-run OK" "$out" "STATE post-run: OK"
out=$(cs rollback); expect "rollback on decision (batch 5) verifies DONE" "$out" '"verdict":"DONE"'

echo "##### batch 6: an earlier KEPT batch changed"
out=$(slice 6 16 18); expect "slice 6" "$out" "slice 6 ok"
out=$(prepare 6); expect "E batch 6" "$out" "attempt: $CAN/attempt-"; A4=$(attempt)
out=$(CANARY_MEMBERS=$RUN/batch-6.members cs G); expect "G runs batch 6" "$out" "dream rc=0"
cs H >/dev/null
kid=$(python3 -I -c "import json,glob;print(json.load(open(sorted(glob.glob('$CAN/stage2-kept/*.json'))[0]))[0]['id'])")
korig=$(psql -XAt -c "select content_hash from pages where id = $kid"); psql -XAt -c "update pages set content_hash = 'rehearsal-tamper' where id = $kid" >/dev/null
out=$(python3 -I "$O/date_gates.py" "$A4" "$RUN/batch-6.members" "$CAN/stage2-kept" 2>&1); rc=$?
expect "date_gates FAIL when an earlier kept batch changed" "$out" "earlier kept batch changed"; expect "that FAIL is exit 10 (complete evidence)" "$rc" "10"
cs I >/dev/null; cs K >/dev/null; labels "$A4/rating"
out=$(CANARY_MEMBERS=$RUN/batch-6.members cs S); expect "S refuses without a bound gates.ok" "$out" "no gates.ok"
out=$(cs rollback); expect "rollback on decision (batch 6) verifies DONE" "$out" '"verdict":"DONE"'
psql -XAt -c "update pages set content_hash = '$korig' where id = $kid" >/dev/null   # undo the batch-6 tamper for later kept checks
gates() { python3 -I "$O/date_gates.py" "$1" "$2" "$CAN/stage2-kept" 2>&1; }

echo "##### batch 7: one malformed output -> bounded retry succeeds"
out=$(slice 7 19 21); expect "slice 7" "$out" "slice 7 ok"
out=$(prepare 7); expect "E batch 7" "$out" "attempt: $CAN/attempt-"; A7=$(attempt); M7=$RUN/batch-7.members
echo 1 > "$OUT/ctl/malformed_left"
out=$(CANARY_MEMBERS=$M7 cs G); expect "G runs batch 7 (one malformed output)" "$out" "dream rc=0"
cs H >/dev/null
out=$(gates "$A7" "$M7"); rc=$?; expect "gates FAIL (10) on the failed pair only" "$rc:$out" "10:"; expect "...naming a failed state row" "$out" "failed state row"
out=$(st pre-open); expect "pre-open OK before R" "$out" "STATE pre-open: OK"
kid7=$(python3 -I -c "import json,glob;print(json.load(open(sorted(glob.glob('$CAN/stage2-kept/*.json'))[0]))[0]['id'])")
korig7=$(psql -XAt -c "select content_hash from pages where id = $kid7"); psql -XAt -c "update pages set content_hash = 'rehearsal-tamper' where id = $kid7" >/dev/null
out=$(CANARY_MEMBERS=$M7 cs R); expect "R refuses when an earlier kept batch changed (full gate context)" "$out" "not a bounded malformed-output retry"
expect "...and writes no retry.manifest" "$(ls "$A7/retry.manifest" 2>&1)" "No such file"
psql -XAt -c "update pages set content_hash = '$korig7' where id = $kid7" >/dev/null
out=$(CANARY_MEMBERS=$M7 cs R); expect "R plans exactly 1 retry pair" "$out" '"retry_pairs": 1'; expect "R's retry dream rc 0" "$out" "dream rc=0"
expect "...with no retry failures" "$out" "retry failures: []"
out=$(st post-run); expect "post-run OK after R" "$out" "STATE post-run: OK"
expect "G-pass captures kept read-only" "$(stat -c %a "$A7/after.g1.json" "$A7/plan.g1.json" | paste -sd,)" "444,444"
cs H >/dev/null
out=$(gates "$A7" "$M7"); expect "date_gates PASS after the retry" "$out" "GATES: PASS"; expect "...counting 1 retried pair" "$out" '"retried": 1'
cp -p "$A7/retry-snapshot.json" "$RUN/snap7.bak"; python3 -I - "$A7/retry-snapshot.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); p = next(k for k, v in s['pairs'].items() if v['atoms']); s['pairs'][p]['atoms'][0][1] = 'tampered'
json.dump(s, open(sys.argv[1], 'w'))
PY
out=$(gates "$A7" "$M7"); rc=$?; expect "control: a changed completed pair fails the gates (10)" "$rc:$out" "10:"; expect "...as 'retry changed'" "$out" "retry changed 1 completed pair"
cp -p "$RUN/snap7.bak" "$A7/retry-snapshot.json"; out=$(gates "$A7" "$M7"); expect "snapshot restored: PASS again" "$out" "GATES: PASS"
cp -p "$A7/run-retry.json" "$RUN/rr7.bak"; : > "$A7/run-retry.json"
out=$(gates "$A7" "$M7"); rc=$?; expect "control: a zero-byte retry outcome is exit 2, never PASS" "$rc:$out" "2:STOP"
expect "...and leaves no gates.ok" "$(ls "$A7/gates.ok" 2>&1)" "No such file"
cp -p "$RUN/rr7.bak" "$A7/run-retry.json"; out=$(gates "$A7" "$M7"); expect "outcome restored: PASS again" "$out" "GATES: PASS"
out=$(CANARY_MEMBERS=$M7 cs R); expect "R re-entry refused (allowance used)" "$out" "retry allowance of this attempt is used"
cs I >/dev/null; out=$(cs K); expect "K kit after the retry" "$out" "kit/"; labels "$A7/rating"
out=$(CANARY_MEMBERS=$M7 cs S); expect "S PASS after the retry" "$out" "ACCEPTANCE (rating): PASS"
out=$(CANARY_MEMBERS=$M7 cs resume); expect "resume records the retried batch" "$out" "kept record"

echo "##### batch 8: malformed again in R -> STOP"
out=$(slice 8 22 24); expect "slice 8" "$out" "slice 8 ok"
out=$(prepare 8); expect "E batch 8" "$out" "attempt: $CAN/attempt-"; A8=$(attempt); M8=$RUN/batch-8.members
echo 1 > "$OUT/ctl/malformed_left"
out=$(CANARY_MEMBERS=$M8 cs G); expect "G runs batch 8 (one malformed output)" "$out" "dream rc=0"
cs H >/dev/null; gates "$A8" "$M8" >/dev/null
echo 1 > "$OUT/ctl/malformed_left"
out=$(CANARY_MEMBERS=$M8 cs R); expect "R runs (dream rc 0)" "$out" "dream rc=0"; expect "...and reports the repeated malformed output" "$out" "malformed model output"
out=$(st post-run); expect "post-run OK after the failed retry" "$out" "STATE post-run: OK"
cs H >/dev/null
out=$(gates "$A8" "$M8"); rc=$?; expect "re-gates FAIL (10) after a second malformed output" "$rc:$out" "10:"
out=$(CANARY_MEMBERS=$M8 cs R); expect "R re-entry refused (no second retry)" "$out" "retry allowance of this attempt is used"
out=$(cs rollback); expect "rollback on decision (batch 8) verifies DONE" "$out" '"verdict":"DONE"'

echo "##### batch 9: failure after R's OPEN"
out=$(slice 9 25 27); expect "slice 9" "$out" "slice 9 ok"
out=$(prepare 9); expect "E batch 9" "$out" "attempt: $CAN/attempt-"; A9=$(attempt); M9=$RUN/batch-9.members
echo 1 > "$OUT/ctl/malformed_left"
out=$(CANARY_MEMBERS=$M9 cs G); expect "G runs batch 9 (one malformed output)" "$out" "dream rc=0"
cs H >/dev/null; gates "$A9" "$M9" >/dev/null
out=$(CANARY_DRYRUN_FAULT=retry-after-open CANARY_MEMBERS=$M9 cs R); rc=$?
expect "R's trap reports both closures verified" "$out" "admission closed: verified; corpus key absent (db+file): verified"; expect "...with a failure status" "$([[ $rc != 0 ]] && echo nonzero)" "nonzero"
out=$(st post-run); expect "post-run OK after R's trap" "$out" "STATE post-run: OK"
out=$(CANARY_MEMBERS=$M9 cs R); expect "R re-entry refused after the interruption" "$out" "retry allowance of this attempt is used"
out=$(cs rollback); expect "rollback on decision (batch 9) verifies DONE" "$out" '"verdict":"DONE"'
out=$(st post-rollback); expect "post-rollback OK" "$out" "STATE post-rollback: OK"

echo "##### batch 10: R's dream leaves no outcome"
out=$(slice 10 28 30); expect "slice 10" "$out" "slice 10 ok"
out=$(prepare 10); expect "E batch 10" "$out" "attempt: $CAN/attempt-"; A10=$(attempt); M10=$RUN/batch-10.members
echo 1 > "$OUT/ctl/malformed_left"
out=$(CANARY_MEMBERS=$M10 cs G); expect "G runs batch 10 (one malformed output)" "$out" "dream rc=0"
cs H >/dev/null; gates "$A10" "$M10" >/dev/null
out=$(CANARY_DRYRUN_FAULT=retry-empty-output CANARY_MEMBERS=$M10 cs R); rc=$?
expect "R STOPs on an unknown retry outcome" "$out" "STOP: unknown retry outcome"; expect "...with a failure status" "$([[ $rc != 0 ]] && echo nonzero)" "nonzero"
out=$(st post-run); expect "post-run OK after the unknown outcome" "$out" "STATE post-run: OK"
out=$(CANARY_MEMBERS=$M10 cs R); expect "R re-entry refused after the unknown outcome" "$out" "retry allowance of this attempt is used"
cs H >/dev/null
out=$(gates "$A10" "$M10"); rc=$?; expect "downstream gates refuse the unknown outcome (2)" "$rc:$out" "2:STOP"
out=$(cs rollback); expect "rollback on decision (batch 10) verifies DONE" "$out" '"verdict":"DONE"'
out=$(st post-rollback); expect "post-rollback OK (batch 10)" "$out" "STATE post-rollback: OK"
echo "RESULT: $FAILS failure(s)"; exit $FAILS
