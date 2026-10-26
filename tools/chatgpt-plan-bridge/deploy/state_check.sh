#!/bin/bash
# Stage-2 runbook state check (STAGE2-DESIGN r3). READ-ONLY: asserts the state each runbook point requires where the
# unchanged canary.sh does not enforce it; prints every reading. Any failed assertion exits 1 = STOP (never a rollback).
#   state_check.sh <pre-open|post-run|post-resume|post-rollback>
#     pre-open      (after D, before G): runners stopped, no runner process, 0 live locks, admission CLOSED,
#                   corpus key PRESENT in the DB, bridge latch clear, route Luna
#     post-run      (after G, any exit):  admission CLOSED, runners stopped, no runner process, 0 live locks, latch clear
#     post-resume   (after resume):       admission CLOSED, corpus key ABSENT (DB + file), autopilot active
#     post-rollback (after rollback):     admission CLOSED, corpus key ABSENT (DB + file), autopilot active, route Gemma
# Recovery when post-run fails on admission or the corpus key is the runbook's 'close by hand' block, then re-run this.
set -uo pipefail
MODE=${1:?mode}
D=/root/work/dream-s552-luna/canary CFG=/root/.gbrain/config.json PORT=18795
source /root/.gbrain/pg.env; export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE=gbrain_pingu PGPASSWORD="$PASS"
bad=0
say() { printf '%-34s %s\n' "$1" "$2"; }
want() { if [[ $2 == "$3" ]]; then say "$1" "$2 OK"; else say "$1" "$2 (want $3) FAIL"; bad=1; fi; }
q() { psql -XAt -v ON_ERROR_STOP=1 -c "$1" 2>&1 || { echo "QUERY FAILED: $1"; bad=1; }; }
adm=$(q "select value from config where key='cycle.extract_atoms.admit_hashes_file'")
cdb=$(q "select count(*) from config where key='dream.synthesize.session_corpus_dir'")
cfile=$(python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print(1 if (c.get("dream") or {}).get("synthesize",{}).get("session_corpus_dir") else 0)' "$CFG" 2>&1)
route=$(q "select value from config where key='models.dream.extract_atoms'")
auto=$(systemctl is-active gbrain-autopilot.service); timer=$(systemctl is-active gbrain-dream.timer)
runners=$(pgrep -af 'gbrain (autopilot|dream|cycle)|src/cli.ts (autopilot|dream|cycle)' | grep -v pgrep || true)
locks=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()")
latch=$(printf 'header = "Authorization: Bearer %s"\n' "$(< /etc/chatgpt-plan-bridge/caller.secret)" | curl -sS -f -K - "http://127.0.0.1:$PORT/v1/bridge/status" 2>&1 \
        | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("clear" if d.get("halted") is None else "SET:" + str(d.get("halted")))' 2>&1)
want "admission" "$adm" "$D/closed.manifest"
case "$MODE" in
pre-open)  want "autopilot" "$auto" inactive; want "dream timer" "$timer" inactive; want "runner processes" "${runners:-none}" none
           want "live cycle locks" "$locks" 0; want "corpus key (db)" "$cdb" 1; want "bridge latch" "$latch" clear
           want "route" "$route" 'litellm:gpt-6-luna@medium' ;;
post-run)  want "autopilot" "$auto" inactive; want "dream timer" "$timer" inactive; want "runner processes" "${runners:-none}" none
           want "live cycle locks" "$locks" 0; want "bridge latch" "$latch" clear ;;
post-resume|post-rollback)
           want "corpus key (db)" "$cdb" 0; want "corpus key (file)" "$cfile" 0; want "autopilot" "$auto" active
           [[ $MODE == post-rollback ]] && want "route" "$route" 'llama-server:gemma-4-12b-qat' ;;
*) echo "unknown mode $MODE"; exit 2 ;;
esac
if [[ $bad == 0 ]]; then echo "STATE $MODE: OK"; else echo "STATE $MODE: FAIL -> STOP (report; never an automatic rollback)"; fi
exit $bad
