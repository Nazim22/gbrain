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
expect "D points a dry run at a closed port, never the live bridge" "$out" "provider_base_urls.litellm = http://127.0.0.1:1/v1"
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
# Freshness (DESIGN §8 r5): history is validated fail-closed, and a failed E removes only its own new dir.
F0="$OUT/attempt-19700101T000000Z"; mkdir "$F0"; printf 'nothex\t/x\n' > "$F0/canary.manifest"; n0=$(ls -d "$OUT"/attempt-* | wc -l)
sleep 1; out=$(run E); expect "E refuses malformed history" "$out" "malformed history line"
expect "a refused E removed only its own new dir" "$(ls -d "$OUT"/attempt-* | wc -l)" "$n0"
rm "$F0/canary.manifest"
sleep 1; out=$(run E); expect "E refuses a history dir without a manifest" "$out" "REFUSE: E failed"
tail -n +11 "$A/inventory/missing.manifest" > "$F0/canary.manifest"
sleep 1; out=$(run E); expect "E refuses fewer than 20 eligible parts" "$out" "eligible parts (need 20)"
rm -r "$F0"
sleep 1; out=$(run E); expect "E allows a new attempt after the previous one closed" "$out" "attempt: $OUT/attempt-"
A2=$(cat "$OUT/ATTEMPT")
disj=$(python3 -I - "$A/canary.manifest" "$A2/canary.manifest" <<'PY'
import sys
a, b = ([l.split('\t') for l in open(f).read().splitlines()] for f in sys.argv[1:3])
print('DISJOINT' if not ({h for h, _ in a} & {h for h, _ in b} or {p for _, p in a} & {p for _, p in b}) else 'OVERLAP', len(b))
PY
)
expect "the new manifest shares no hash and no path with the earlier one" "$disj" "DISJOINT 20"
out=$(run S); expect "S refuses without a kit" "$out" "no kit (run K)"
out=$(run F); expect "F captures before for the new attempt" "$out" '"preflight":"CLEAN"'
out=$(run K); expect "K refuses before H ran" "$out" "H has not run"
cp -p "$A2/before.json" "$A2/after.json"   # stand-in AFTER: only to reach resume's rating gate
out=$(run resume); expect "resume refuses without a rating PASS" "$out" "no rating PASS"
# S maps exits mechanically: invalid labels STOP (never a score), a scored FAIL writes no PASS, only a real PASS writes it.
R2=$A2/rating; mkdir -p "$R2"; printf '{"aaaaaaaa": {"atom_id": 1, "part": "part-01", "verified": true}, "bbbbbbbb": {"atom_id": 2, "part": "part-01", "verified": true}}' > "$R2/key.json"
lab() { rm -f "$R2/$1"; printf '{"bid": "aaaaaaaa", "part": "part-01", "fidelity": %s, "generic": false, "claim_key": "a", "evidence": "", "reason": "r"}\n{"bid": "bbbbbbbb", "part": "part-01", "fidelity": "%s", "generic": false, "claim_key": "b", "evidence": "", "reason": "r"}\n' "$2" "$3" > "$R2/$1"; }
lab labels-r1.jsonl '[]' supported; lab labels-r2-pebble.jsonl '"supported"' supported
out=$(run S); expect "S stops on unscorable labels (fidelity [] is invalid, never a FAIL)" "$out" "was not scored (exit 2)"
lab labels-r1.jsonl '"supported"' unsupported
out=$(run S); expect "S reports a scored FAIL" "$out" "ACCEPTANCE (rating): FAIL"
expect "a scored FAIL writes no rating/PASS" "$(ls "$R2/PASS" 2>&1)" "No such file"
lab labels-r1.jsonl '"supported"' supported
out=$(run S); expect "S passes only when both raters pass" "$out" "ACCEPTANCE (rating): PASS"
expect "rating/PASS written" "$(ls "$R2/PASS" 2>&1)" "$R2/PASS"
echo "RESULT: $FAILS failure(s)"; exit $FAILS
