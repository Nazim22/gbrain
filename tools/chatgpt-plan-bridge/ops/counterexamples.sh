#!/bin/bash
# Counterexamples for rollback-batch.ts (Pebble 05:51Z items 2–3), on a SCRATCH brain only, local model, no cloud.
# Usage: counterexamples.sh <scratch-db> <gbrain-home> <manifest> <outdir>
set -uo pipefail
DB=$1 HOMEG=$2 M=$3 L=$4
W=$(cd "$(dirname "$0")/../../.." && pwd); OPS=$W/tools/chatgpt-plan-bridge/ops; CORPUS=/root/.claude/projects/-root/session-text
source /root/.gbrain/pg.env
export GBRAIN_HOME=$HOMEG HOME=/root DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/$DB"   # environment only (bun tools)
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE="$DB" PGPASSWORD="$PASS"     # psql gets no URI on its argv
[[ $(psql -XAtc 'select current_database()') == gbrain_s552_* ]] || { echo "REFUSE: not a scratch DB"; exit 1; }
gb() { (cd "$W" && bun src/cli.ts "$@"); }
q() { psql -XAt -F ' | ' -c "$1"; }
step() { echo; echo "=== $(date -u +%FT%TZ) $*"; }
expect() { if [[ "$2" == *"$3"* ]]; then echo "OK   $1"; else echo "FAIL $1: wanted '$3' in: $2"; FAILS=$((FAILS+1)); fi; }
FAILS=0; install -d -m 0700 "$L" "$L/checkout"; : > "$L/closed"
gb config set dream.synthesize.session_corpus_dir $CORPUS >/dev/null; gb config set dream.synthesize.enabled false >/dev/null
run() { gb config set cycle.extract_atoms.admit_hashes_file "$M" >/dev/null; gb dream --source default --dir "$L/checkout" --phase extract_atoms --json > "$L/$1.json" 2> "$L/$1.err"; gb config set cycle.extract_atoms.admit_hashes_file "$L/closed" >/dev/null; }
cap() { bun "$OPS/writeset.ts" capture "$M" "$CORPUS" "$L/$1.json" ${2:+--like "$L/$2.json"} >/dev/null; }

step "setup: run once, then make that receipt an OLD live receipt (backdated 3 days) in today's slug family"
run seed
RID=$(q "select id from pages where type='extract_receipt' and slug like 'extracts/'||to_char(now() at time zone 'utc','YYYY-MM-DD')||'/atoms/default/%' order by id desc limit 1")
q "update pages set created_at = now() - interval '3 days', updated_at = now() - interval '3 days' where id = $RID" >/dev/null
echo "old receipt id=$RID"
# The seed atoms are pre-existing LIVE atoms for these sources: retire them as rollback-owned so preflight admits the retry.
cap seed_before_rb
bun -e "
import postgres from 'postgres'; import {readFileSync} from 'node:fs';
const sql=postgres(process.env.DATABASE_URL!,{max:1}); const paths=readFileSync('$M','utf8').split('\n').filter(Boolean).map(l=>l.split('\t')[1]);
await sql\`update pages set deleted_at=now(), frontmatter=frontmatter||jsonb_build_object('retired_by','luna-batch-rollback','retired_at',now()::text) where type='atom' and deleted_at is null and frontmatter->>'source_path' = any(\${paths})\`;
await sql\`delete from derived_generation_items where generation_id in (select id from derived_generations where kind='atom')\`; await sql\`delete from derived_generations where kind='atom'\`;
await sql\`delete from extract_atoms_transcript_state where file_path = any(\${paths})\`; await sql.end();"

step "1. old receipt reused by a run is captured (any age) and restored to its before-state"
cap before
bun "$OPS/writeset.ts" preflight "$L/before.json"
run r1; cap after before
PLAN=$(bun "$OPS/rollback-batch.ts" plan "$L/before.json" "$L/after.json"); echo "$PLAN"
expect "old receipt is a CHANGED receipt (not new)" "$PLAN" "\"changed_receipts\":1"
PRE=$(bun "$OPS/rollback-batch.ts" verify "$L/before.json" "$L/after.json"); RC=$?; expect "before apply = NOT_APPLIED" "$PRE" '"verdict":"NOT_APPLIED"'
expect "verify exits 3 on NOT_APPLIED" "rc=$RC" "rc=3"

step "2a. guard on generations: a generation row changed after the AFTER capture → apply refuses, nothing mutated"
GID=$(q "select id from derived_generations where kind='atom' order by id desc limit 1")
q "update derived_generations set item_set_hash = item_set_hash || 'x' where id = $GID" >/dev/null
OUT=$(bun "$OPS/rollback-batch.ts" apply "$L/before.json" "$L/after.json" 2>&1); RC=$?; echo "$OUT" | tail -1
expect "apply refuses a tampered generation" "$OUT" '"refused"'
expect "refused apply exits 2" "rc=$RC" "rc=2"
q "update derived_generations set item_set_hash = left(item_set_hash, length(item_set_hash)-1) where id = $GID" >/dev/null

step "2. guard: a row changed after the AFTER capture aborts apply with nothing mutated"
NEWID=$(echo "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["new_atom_ids"][0])')
q "update pages set frontmatter = frontmatter || '{\"tamper\":1}'::jsonb where id = $NEWID" >/dev/null
OUT=$(bun "$OPS/rollback-batch.ts" apply "$L/before.json" "$L/after.json" 2>&1); echo "$OUT" | tail -2
expect "apply refuses a state that is neither AFTER nor ROLLED-BACK" "$OUT" '"refused"'
LIVE=$(q "select count(*) from pages where id in (select (jsonb_array_elements_text('$(echo "$PLAN" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["new_atom_ids"]))')'::jsonb))::int) and deleted_at is null")
expect "no new atom was retired by the refused apply" "live=$LIVE" "live=$(echo "$PLAN" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["new_atom_ids"]))')"
q "update pages set frontmatter = frontmatter - 'tamper' where id = $NEWID" >/dev/null

step "3. clean apply → DONE; receipt restored exactly"
OUT=$(bun "$OPS/rollback-batch.ts" apply "$L/before.json" "$L/after.json"); RC=$?; echo "$OUT"
expect "apply verdict DONE" "$OUT" '"verdict":"DONE"'
expect "apply exits 0 on DONE" "rc=$RC" "rc=0"
R=$(q "select deleted_at is null, updated_at < now() - interval '1 day' or true from pages where id=$RID"); expect "old receipt live again (its before-state)" "$R" "t |"

step "4. idempotent: a second apply is a no-op"
OUT=$(bun "$OPS/rollback-batch.ts" apply "$L/before.json" "$L/after.json"); expect "second apply = already" "$OUT" '"applied":"already"'

step "5. partial state (one row un-rolled by hand) → verify STOP; apply refuses"
q "update pages set deleted_at = null, frontmatter = frontmatter - 'retired_by' - 'retired_at' where id = $NEWID" >/dev/null
OUT=$(bun "$OPS/rollback-batch.ts" verify "$L/before.json" "$L/after.json"); RC=$?; expect "verify STOP on a mixed state" "$OUT" '"verdict":"STOP"'
expect "verify exits 2 on STOP" "rc=$RC" "rc=2"
OUT=$(bun "$OPS/rollback-batch.ts" apply "$L/before.json" "$L/after.json" 2>&1); expect "apply refuses a mixed state" "$OUT" '"refused"'

step "RESULT: $FAILS failure(s)"; exit $FAILS
