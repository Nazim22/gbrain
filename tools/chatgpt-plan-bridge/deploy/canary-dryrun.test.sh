#!/bin/bash
# Dry run of canary.sh against a SCRATCH brain (CANARY_DRYRUN=1): attempt + binding refusals and the recovery path.
# Usage: canary-dryrun.test.sh <scratch-db gbrain_s552_*> <scratch gbrain home> <out dir>    (run from a clean committed head)
set -u
DB=$1 HOMEG=$2 OUT=$3
W=$(cd "$(dirname "$0")/../../.." && pwd); C="$W/tools/chatgpt-plan-bridge/deploy/canary.sh"; HEAD=$(git -C "$W" rev-parse HEAD)
export CANARY_DRYRUN=1 CANARY_DB=$DB GBRAIN_HOME=$HOMEG CANARY_DIR=$OUT
source /root/.gbrain/pg.env; export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE=$DB PGPASSWORD="$PASS"
FAILS=0
run() { bash "$C" "$1" "$HEAD" 2>&1; }
expect() { if [[ "$2" == *"$3"* ]]; then echo "OK   $1"; else echo "FAIL $1: wanted '$3' in: $(echo "$2" | tail -3)"; FAILS=$((FAILS+1)); fi; }
mkdir -p "$OUT"
out=$(run D);      expect "D sets config on the scratch DB" "$out" "cycle.extract_atoms.admit_hashes_file = $OUT/closed.manifest"
expect "D sets the file-plane base url in the scratch home" "$out" "provider_base_urls.litellm = http://127.0.0.1:18795/v1"
out=$(run E);      expect "E creates a fresh attempt" "$out" "attempt: $OUT/attempt-"
A=$(cat "$OUT/ATTEMPT")
sleep 1; out=$(run E); expect "E refuses while the previous attempt is open" "$out" "still open"
out=$(run H);      expect "H refuses before G ran" "$out" "REFUSE"
out=$(run F);      expect "F captures before + preflight" "$out" '"preflight":"CLEAN"'
out=$(run F);      expect "F refuses a second capture" "$out" "before.json exists"
cp -p "$A/canary.manifest" "$OUT/m.bak"; chmod u+w "$A/canary.manifest"; echo "0000000000000000	/x" >> "$A/canary.manifest"
out=$(run G);      expect "G refuses a manifest not bound to before.json" "$out" "not bound to this manifest"
cp -p "$OUT/m.bak" "$A/canary.manifest"
cp -p "$A/preflight.ok" "$OUT/p.bak"; chmod u+w "$A/preflight.ok"; echo "tampered" > "$A/preflight.ok"
out=$(run G);      expect "G refuses a preflight marker that does not bind" "$out" "preflight.ok does not bind"
cp -p "$OUT/p.bak" "$A/preflight.ok"
out=$(run G);      expect "G refuses without a reachable, unlatched bridge" "$out" "bridge halt latch is set (or status unavailable)"
adm=$(psql -XAt -c "select value from config where key='cycle.extract_atoms.admit_hashes_file'")
expect "admission stayed CLOSED after the refused G" "$adm" "$OUT/closed.manifest"
out=$(run resume); expect "resume refuses without an AFTER capture" "$out" "H has not captured AFTER"
out=$(run rollback); expect "rollback captures the missing write set" "$out" "capturing the post-failure write set"
expect "rollback binds after.json to this attempt" "$out" "after.json bound to this attempt"
expect "rollback verifies DONE" "$out" '"verdict":"DONE"'
expect "rollback disables extraction (corpus key absent)" "$out" "extraction disabled"
expect "rollback restarts autopilot only as a dry-run no-op" "$out" "[dry-run] systemctl start gbrain-autopilot.service"
expect "attempt marked closed" "$(cat "$A/closed" 2>/dev/null)" "rolled-back"
sleep 1; out=$(run E); expect "E allows a new attempt after the previous one closed" "$out" "attempt: $OUT/attempt-"
echo "RESULT: $FAILS failure(s)"; exit $FAILS
