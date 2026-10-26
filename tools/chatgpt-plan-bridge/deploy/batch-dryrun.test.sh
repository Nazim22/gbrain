#!/bin/bash
# Composed dry run of batch.sh against a SCRATCH brain (BATCH_DRYRUN=1; Pebble IMPLEMENTATION HOLD 33d287fe):
# stub bridge, scratch copies of 6 corpus parts, scratch converter, scratch gbrain home, scratch run dirs.
#  A: converter, freeze (2 batches of 3), C, D; batch 1 runs E V B F G H K S keep (with out-of-order refusals);
#     batch 2 hits an injected dream failure after OPEN -> HOLD, admission closed, corpus key absent, run stopped;
#     rollback on decision writes a receipt; end.
#  B: a fresh run over the 3 parts batch 2 left (already dated, so no rename); the stub serves the wrong model, so H's
#     gate fails, keep/K refuse, rollback retires the atoms with a receipt; the inventory readmits those parts only while
#     the receipt verifies (tampered -> not readmitted); end.
# Usage: batch-dryrun.test.sh <scratch-db gbrain_s552_*> <source scratch gbrain home> <out dir> <plan run.manifest>
# (run from a clean committed head; <plan run.manifest> = a date_parts.py plan output to pick 6 MISSING parts from)
set -u
DB=$1 SRCHOME=$2 OUT=$3 PLAN=$4
[[ $DB == gbrain_s552_* ]] || { echo "REFUSE: scratch DB only"; exit 1; }
W=$(cd "$(dirname "$0")/../../.." && pwd); BS="$W/tools/chatgpt-plan-bridge/deploy/batch.sh"; OPS="$W/tools/chatgpt-plan-bridge/ops"; HEAD=$(git -C "$W" rev-parse HEAD)
mkdir -p "$OUT"; [[ -z $(ls -A "$OUT") ]] || { echo "REFUSE: $OUT must be empty"; exit 1; }
mkdir -p "$OUT/corpus" "$OUT/conv" "$OUT/ctl"
cp -a "$SRCHOME" "$OUT/home"
git -C "$W" show 2e819086a:tools/chatgpt-plan-bridge/ingest/ingest-session-transcript.py > "$OUT/conv/ingest-session-transcript.py"
head -c 24 /dev/urandom | base64 > "$OUT/secret"; chmod 600 "$OUT/secret"; : > "$OUT/ledger.jsonl"; echo ok > "$OUT/ctl/mode"
head -6 "$PLAN" | cut -f3 | while read -r p; do cp -p "$p" "$OUT/corpus/"; done
PORT=$((20000 + RANDOM % 20000))
python3 -I "$W/tools/chatgpt-plan-bridge/deploy/stub_bridge.py" "$PORT" "$OUT/secret" "$OUT/ledger.jsonl" "$OUT/ctl" & STUB=$!
trap 'kill $STUB 2>/dev/null' EXIT; sleep 1
export BATCH_DRYRUN=1 BATCH_DB=$DB BATCH_CORPUS=$OUT/corpus BATCH_CONV=$OUT/conv/ingest-session-transcript.py GBRAIN_HOME=$OUT/home
export BATCH_PORT=$PORT BATCH_SECRET=$OUT/secret BATCH_LEDGER=$OUT/ledger.jsonl BATCH_SIZE=3
source /root/.gbrain/pg.env; export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE=$DB PGPASSWORD="$PASS"
FAILS=0
run() { bash "$BS" "$@" "$HEAD" 2>&1; }
runb() { local s=$1; shift; bash "$BS" "$s" "$HEAD" "$@" 2>&1; }
expect() { if [[ "$2" == *"$3"* ]]; then echo "OK   $1"; else echo "FAIL $1: wanted '$3' in: $(echo "$2" | tail -4)"; FAILS=$((FAILS+1)); fi; }
adm() { psql -XAt -c "select value from config where key='cycle.extract_atoms.admit_hashes_file'"; }
corpus_n() { psql -XAt -c "select count(*) from config where key='dream.synthesize.session_corpus_dir'"; }
labels() {   # synthetic blind labels: every atom supported, schema exact
  python3 -I - "$1" <<'PY'
import json, sys
r = sys.argv[1]; key = json.load(open(f'{r}/key.json'))
for f in ('labels-r1.jsonl', 'labels-r2-pebble.jsonl'):
    open(f'{r}/{f}', 'w').write(''.join(json.dumps({'bid': b, 'part': v['part'], 'fidelity': 'supported', 'generic': False,
        'claim_key': b, 'evidence': '', 'reason': 'dry run'}) + '\n' for b, v in key.items()))
print(len(key), 'labels each')
PY
}

echo "##### scenario A"; export BATCH_RUN=$OUT/runA
out=$(run freeze);           expect "freeze refuses before the reviewed converter is live" "$out" "reviewed converter is not live"
out=$(run converter);        expect "converter installs the candidate (scratch path)" "$out" "converter live"
out=$(run freeze);           expect "freeze writes one run.manifest of 2 batches" "$out" "-> 2 batches of <= 3"
out=$(run freeze);           expect "freeze refuses a second freeze" "$out" "already frozen"
out=$(run C);                expect "C pauses runners as a dry-run no-op" "$out" "[dry-run] systemctl stop gbrain-autopilot.service"
out=$(run D);                expect "D leaves the corpus key ABSENT" "$out" "corpus key: absent"
expect "D points the scratch home at the stub" "$out" "provider_base_urls.litellm = http://127.0.0.1:$PORT/v1"
out=$(runb E 2);             expect "E refuses batch 2 before batch 1 is closed" "$out" "batch 1 is not closed"
out=$(runb E 1);             expect "E batch 1 keeps 3 members and renames them" "$out" "3 kept, 0 dropped"
expect "E batch 1 member bytes stable after rename" "$out" "member bytes stable: all"
expect "renamed files carry the date prefix" "$(ls "$OUT/corpus" | grep -c -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-session-')" "3"
out=$(runb F 1);             expect "F captures before + preflight" "$out" '"preflight":"CLEAN"'
out=$(runb G 1);             expect "G refuses without V.ok/B.ok" "$out" "V.ok missing"
out=$(runb B 1);             expect "B refuses before V" "$out" "V.ok missing"
out=$(runb V 1);             expect "V checks 401 + 200 + latch + route on the stub" "$out" "status 200, latch clear"
out=$(runb B 1);             expect "B makes one call served by luna" "$out" "served"
out=$(runb K 1);             expect "K refuses before H (no gated.ok)" "$out" "gated.ok missing"
out=$(runb keep 1);          expect "keep refuses before H (no gated.ok)" "$out" "gated.ok missing"
out=$(runb G 1);             expect "G opens, extracts, closes and proves quiescence" "$out" "QUIESCED"
expect "after G: admission closed" "$(adm)" "$OUT/runA/closed.manifest"; expect "after G: corpus key absent" "$(corpus_n)" "0"
out=$(runb H 1);             expect "H passes every gate and writes gated.ok" "$out" "GATED: PASS"
echo "$out" | grep -E '"(new_atoms|pairs_with_atoms|fail_count)"'
out=$(runb K 1);             expect "K builds the kit" "$out" "kit/"
labels "$OUT/runA/batch-01/rating"
out=$(runb S 1);             expect "S passes on both raters" "$out" "RATING: PASS"
out=$(runb keep 1);          expect "keep records the batch" "$out" "kept"
out=$(runb E 2);             expect "E batch 2 freezes its slice" "$out" "3 kept, 0 dropped"
runb V 2 >/dev/null; runb B 2 >/dev/null; runb F 2 >/dev/null
out=$(BATCH_DRYRUN_FAULT=dream-exit runb G 2); expect "G with a failure after OPEN HOLDs" "$out" "HOLD (§7.1)"
expect "after the HOLD: admission closed" "$(adm)" "$OUT/runA/closed.manifest"; expect "after the HOLD: corpus key absent" "$(corpus_n)" "0"
expect "the run is stopped as an unknown outcome" "$(cat "$OUT/runA/STOP")" "unknown outcome"
out=$(runb H 2);             expect "H refuses while the run is stopped" "$out" "run is stopped"
out=$(runb rollback 2);      expect "rollback on decision verifies DONE" "$out" '"verdict":"DONE"'
expect "rollback writes a receipt" "$out" "receipt $OUT/runA/receipts/batch-02.json"
out=$(run end);              expect "end restores state (dry-run no-op restart)" "$out" "[dry-run] systemctl start gbrain-autopilot.service"
expect "end inventory runs" "$out" "inventory:"

echo "##### scenario B"; export BATCH_RUN=$OUT/runB
out=$(run converter);        expect "converter is idempotent" "$out" "converter live"
out=$(run freeze);           expect "freeze takes the 3 already-dated parts batch 2 left" "$out" "-> 1 batches of <= 3"
run C >/dev/null; run D >/dev/null
out=$(runb E 1);             expect "E: already-dated members are not renamed" "$out" "skip (already dated)"
runb V 1 >/dev/null; out=$(runb B 1); expect "B served by luna" "$out" "served"; runb F 1 >/dev/null
echo wrong-model > "$OUT/ctl/mode"
out=$(runb G 1);             expect "G runs against the wrong-model stub" "$out" "QUIESCED"
out=$(runb H 1);             expect "H fails the served-model gate" "$out" "GATE FAIL (§7.2)"
expect "no gated.ok after a failed gate" "$(ls "$OUT/runB/batch-01/gated.ok" 2>&1)" "No such file"
out=$(runb keep 1);          expect "keep refuses after a failed gate" "$out" "gated.ok missing"
out=$(runb K 1);             expect "K refuses after a failed gate" "$out" "gated.ok missing"
out=$(runb rollback 1);      expect "rollback retires the batch's atoms (DONE)" "$out" '"verdict":"DONE"'
R=$OUT/runB/receipts/batch-01.json
inv() { (export DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/$DB"; bun "$OPS/inventory.ts" "$OUT/corpus" "$1" "$OUT/runB/renames.tsv" "$OUT/runB/receipts" 2>/dev/null > "$1.out"; python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['counts'],'receipted',d['receipted_atoms'])" "$1.out"); }
out=$(inv "$OUT/invB1");     expect "a verified receipt readmits the rolled-back parts" "$out" "'missing-after-rollback': 3"
cp -p "$R" "$OUT/receipt.bak"; python3 -I -c "import json,sys;p=sys.argv[1];r=json.load(open(p));r['after_sha256']='0'*64;open(p,'w').write(json.dumps(r))" "$R"
out=$(inv "$OUT/invB2");     expect "a receipt whose capture hash fails readmits nothing" "$out" "'retired-deliberate': 3"
cp -p "$OUT/receipt.bak" "$R"
out=$(inv "$OUT/invB3");     expect "the restored receipt verifies again" "$out" "'missing-after-rollback': 3"
out=$(run end);              expect "end (run B)" "$out" "inventory:"
echo "RESULT: $FAILS failure(s)"; exit $FAILS
