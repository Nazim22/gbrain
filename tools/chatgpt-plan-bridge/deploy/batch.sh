#!/bin/bash
# Luna stage 2 catch-up (STAGE2-DESIGN r2 18a291d1). ONE step per invocation, output in full:
#   batch.sh <converter|freeze|C|D|end> <reviewed-head-full-sha>
#   batch.sh <E|V|B|F|G|H|K|S|keep|rollback> <reviewed-head-full-sha> <batch-no>
# Run order under the single GO (§8): converter, freeze, C, D; per batch E V B F G H K S keep (a failed gate or rating
# goes to rollback, which stops the run); end. Every step refuses unless the worktree is clean at exactly <reviewed-head>;
# its src/ is the gbrain runtime. A batch dir has the canary attempt layout (canary.manifest, before.json, preflight.ok,
# ...), so writeset.ts, rollback-batch.ts, make_kit.py and score.py are reused unchanged. Live autopilot stays stopped
# from C to end. Fail-closed chain per batch: E members.tsv -> V.ok + B.ok -> preflight.ok -> run.json -> gated.ok
# (bound to plan.json + after.json) -> rating/PASS -> closed. The corpus key exists only between OPEN and CLOSED.
set -euo pipefail
STEP=${1:?step} WANT=${2:?reviewed head} N=${3:-}
W=/root/work/gbrain-s552-luna-bridge OPS=$W/tools/chatgpt-plan-bridge/ops
RUN=/root/work/dream-s552-luna/stage2-run DB=gbrain_pingu CORPUS=/root/.claude/projects/-root/session-text
CONV_LIVE=/root/.gbrain/ingest-session-transcript.py CONV_NEW=$W/tools/chatgpt-plan-bridge/ingest/ingest-session-transcript.py
CONV_BASE_SHA=425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d   # the vendored base (commit 2e819086)
PORT=18795 SECRET=/etc/chatgpt-plan-bridge/caller.secret LEDGER=/srv/chatgpt-plan-bridge/state/requests.jsonl
BATCH=100 ROUTE='litellm:gpt-6-luna@medium' MODEL=gpt-6-luna
# DRY RUN (batch-dryrun.test.sh only): every path below is a scratch override, systemctl is a printed no-op, the
# bridge is a local stub, and the database must be a gbrain_s552_* scratch copy. Refused otherwise.
if [[ ${BATCH_DRYRUN:-} == 1 ]]; then
  [[ ${BATCH_DB:-} == gbrain_s552_* && -n ${BATCH_RUN:-} && -n ${BATCH_CORPUS:-} && -n ${BATCH_CONV:-} && -n ${GBRAIN_HOME:-} \
     && -n ${BATCH_PORT:-} && -n ${BATCH_SECRET:-} && -n ${BATCH_LEDGER:-} ]] || { echo "REFUSE: incomplete dry-run overrides"; exit 1; }
  DB=$BATCH_DB RUN=$BATCH_RUN CORPUS=$BATCH_CORPUS CONV_LIVE=$BATCH_CONV PORT=$BATCH_PORT SECRET=$BATCH_SECRET LEDGER=$BATCH_LEDGER
  BATCH=${BATCH_SIZE:-$BATCH}
fi
dry() { [[ ${BATCH_DRYRUN:-} == 1 ]]; }
CFG="${GBRAIN_HOME:-/root}/.gbrain/config.json"
[[ $(git -C "$W" rev-parse HEAD) == "$WANT" && -z $(git -C "$W" status --porcelain) ]] || { echo "REFUSE: $W is not clean at $WANT"; exit 1; }
source /root/.gbrain/pg.env
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE="$DB" PGPASSWORD="$PASS"   # environment only, never argv
export DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/$DB"
gb() { (cd "$W" && bun src/cli.ts "$@"); }
q() { psql -XAt -v ON_ERROR_STOP=1 -F ' | ' -c "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
step() { echo "=== $(date -u +%FT%TZ) $STEP${N:+ batch $N}: $*"; }
svc() { if dry; then echo "[dry-run] systemctl $*"; else systemctl "$@"; fi; }
runners() { dry && return 0; pgrep -af 'gbrain (autopilot|dream|cycle)|src/cli.ts (autopilot|dream|cycle)' || true; }   # live runners never touch a scratch DB
no_runner() { local r; r=$(runners); [[ -z $r ]] || { echo "REFUSE: a gbrain runner process exists: $r"; exit 1; }; }
luna_env() { export LITELLM_BASE_URL="http://127.0.0.1:$PORT/v1"; export LITELLM_API_KEY="$(< "$SECRET")"; }
bridge_status() { printf 'header = "Authorization: Bearer %s"\n' "$(< "$SECRET")" | curl -sS -f -K - "http://127.0.0.1:$PORT/v1/bridge/status"; }
db_count() { local n; n=$(q "select count(*) from config where key='$1'") || { echo "REFUSE: config query failed for $1" >&2; exit 1; }; [[ $n =~ ^[0-9]+$ ]] || { echo "REFUSE: bad count '$n'" >&2; exit 1; }; echo "$n"; }
db_value() { local v; v=$(q "select value from config where key='$1'") || { echo "REFUSE: config query failed for $1" >&2; exit 1; }; echo "$v"; }
file_has_corpus() { python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print(1 if (c.get("dream") or {}).get("synthesize",{}).get("session_corpus_dir") else 0)' "$CFG"; }
corpus_absent() { [[ $(db_count dream.synthesize.session_corpus_dir) == 0 && $(file_has_corpus) == 0 ]]; }
unset_corpus() { gb config unset dream.synthesize.session_corpus_dir >/dev/null 2>&1 || true; corpus_absent; }
install -d -m 0700 "$RUN" "$RUN/receipts"; [[ -e "$RUN/closed.manifest" ]] || : > "$RUN/closed.manifest"
[[ ! -s "$RUN/closed.manifest" ]] || { echo "REFUSE: closed.manifest is not empty"; exit 1; }
admission_is_closed() { [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$RUN/closed.manifest" ]]; }
close_all() { gb config set cycle.extract_atoms.admit_hashes_file "$RUN/closed.manifest" >/dev/null 2>&1 || true; unset_corpus || true; }
stopped() { [[ ! -e "$RUN/STOP" ]] || { echo "REFUSE: the run is stopped ($(< "$RUN/STOP")); only rollback (on a decision) and end remain"; exit 1; }; }
inventory() {   # fresh read-only inventory with both names + verified receipts
  bun "$OPS/inventory.ts" "$CORPUS" "$1" "$RUN/renames.tsv" "$RUN/receipts" > "$1.out"
  python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print('inventory:',d['discovered'],d['counts'],'independent_live_paths',d['independent_live_paths'],'receipted',d.get('receipted_atoms'))" "$1.out"
}
bdir() { [[ $N =~ ^[0-9]+$ && $N -ge 1 ]] || { echo "REFUSE: batch number required" >&2; exit 1; }; printf '%s/batch-%02d' "$RUN" "$N"; }
need() { local f; for f in "$@"; do [[ -s $f ]] || { echo "REFUSE: $(basename "$f") missing: run the earlier step"; exit 1; }; done; }
open_batch() { [[ ! -e "$1/closed" ]] || { echo "REFUSE: this batch is closed ($(< "$1/closed"))"; exit 1; }; }
bindings() {   # canary.manifest -> before.json -> preflight.ok must agree, or refuse
  local A=$1 m b; need "$A/canary.manifest" "$A/before.json" "$A/preflight.ok"
  m=$(sha "$A/canary.manifest"); b=$(sha "$A/before.json")
  [[ $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifest_sha256"])' "$A/before.json") == "$m" ]] || { echo "REFUSE: before.json is not bound to this manifest"; exit 1; }
  [[ $(< "$A/preflight.ok") == "$b $m" ]] || { echo "REFUSE: preflight.ok does not bind this before.json + manifest"; exit 1; }
}
gated() {   # H's success receipt must bind the CURRENT plan.json + after.json
  local A=$1; need "$A/gated.ok" "$A/plan.json" "$A/after.json"
  [[ $(< "$A/gated.ok") == "$(sha "$A/plan.json") $(sha "$A/after.json")" ]] || { echo "REFUSE: gated.ok does not bind this plan.json + after.json"; exit 1; }
}
members_stable() {   # §3a: every member's bytes equal the run freeze's sha256 (at OPEN and at GATED)
  python3 -I - "$1/members.tsv" <<'PY'
import hashlib, sys
bad = []
for l in open(sys.argv[1]):
    h, sha, legacy, dated, day = l.rstrip('\n').split('\t')
    try: got = hashlib.sha256(open(dated, 'rb').read()).hexdigest()
    except FileNotFoundError: got = 'missing'
    if got != sha: bad.append((dated, got[:12]))
print('member bytes stable:', 'all' if not bad else f'NO {bad[:5]}'); sys.exit(1 if bad else 0)
PY
}

case "$STEP" in
converter) step "install the reviewed converter (live before any rename, §1)"
   [[ $(sha "$CONV_LIVE") == "$CONV_BASE_SHA" || $(sha "$CONV_LIVE") == $(sha "$CONV_NEW") ]] || { echo "REFUSE: installed converter is neither the reviewed base nor the candidate"; exit 1; }
   [[ -e "$RUN/converter.base.py" ]] || cp -p "$CONV_LIVE" "$RUN/converter.base.py"
   install -m 0755 "$CONV_NEW" "$CONV_LIVE.tmp" && mv "$CONV_LIVE.tmp" "$CONV_LIVE"
   [[ $(sha "$CONV_LIVE") == $(sha "$CONV_NEW") ]] || { echo "ALERT: installed bytes differ"; exit 1; }
   echo "converter live: $(sha "$CONV_LIVE") (base kept at $RUN/converter.base.py)" ;;
freeze) step "run freeze (§3a): one finite run.manifest; the GO binds its sha256"
   [[ ! -e "$RUN/run.manifest" ]] || { echo "REFUSE: the run is already frozen"; exit 1; }
   [[ $(sha "$CONV_LIVE") == $(sha "$CONV_NEW") ]] || { echo "REFUSE: the reviewed converter is not live (run 'converter')"; exit 1; }
   inventory "$RUN/freeze-inventory"
   python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));[print(r['hash16']+'\t'+r['path']) for r in d['rows'] if r['class'] in ('missing','missing-after-rollback')]" "$RUN/freeze-inventory/inventory.json" > "$RUN/eligible.manifest"
   python3 -I "$OPS/date_parts.py" plan "$RUN/eligible.manifest" "$RUN/run.manifest" "$RUN/refused.tsv"
   cut -f3 "$RUN/refused.tsv" | sort | uniq -c
   [[ -s "$RUN/run.manifest" ]] || { echo "REFUSE: nothing to run"; exit 1; }
   chmod 0444 "$RUN/run.manifest"; n=$(wc -l < "$RUN/run.manifest")
   sha "$RUN/run.manifest" > "$RUN/run.manifest.sha256"
   echo "run.manifest rows $n -> $(( (n + BATCH - 1) / BATCH )) batches of <= $BATCH; sha256 $(< "$RUN/run.manifest.sha256")" ;;
C) step "pause competing runners for the whole run (single owner)"
   svc stop gbrain-autopilot.service
   if ! dry; then for u in gbrain-autopilot.service gbrain-dream.timer; do s=$(systemctl is-active "$u" || true); echo "$u: $s"; [[ $s != active ]] || { echo "REFUSE: $u active"; exit 1; }; done; fi
   no_runner; live=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()"); echo "live cycle locks: $live"; [[ $live == 0 ]] || exit 1 ;;
D) step "config: synthesize off, route, pricing, file-plane base url, admission CLOSED, corpus key ABSENT (it exists only OPEN..CLOSED)"
   gb config set dream.synthesize.enabled false; gb config set models.dream.extract_atoms "$ROUTE"
   gb pricing set "$ROUTE" --input 0 --output 0 --source "subscription: ChatGPT Pro via Sign in with ChatGPT (owner-verified allowance, Nazz 2026-10-26)"
   python3 -I - "$PORT" "$CFG" <<'PY'
import json, sys, os
p = sys.argv[2]; c = json.load(open(p)); c.setdefault('provider_base_urls', {})['litellm'] = f'http://127.0.0.1:{sys.argv[1]}/v1'
tmp = p + '.tmp'; json.dump(c, open(tmp, 'w'), indent=2); os.chmod(tmp, 0o600); os.replace(tmp, p); print('provider_base_urls.litellm =', c['provider_base_urls']['litellm'])
PY
   gb config set cycle.extract_atoms.admit_hashes_file "$RUN/closed.manifest"; admission_is_closed || { echo "REFUSE: admission not closed"; exit 1; }
   unset_corpus || { echo "REFUSE: corpus key still present"; exit 1; }
   for k in dream.synthesize.enabled models.dream.extract_atoms cycle.extract_atoms.admit_hashes_file; do echo "$k = $(db_value $k)"; done; echo "corpus key: absent" ;;
E) step "batch freeze: drop-only re-check of this slice, renames, batch manifest"
   stopped; A=$(bdir); need "$RUN/run.manifest"
   [[ $(sha "$RUN/run.manifest") == $(< "$RUN/run.manifest.sha256") ]] || { echo "REFUSE: run.manifest changed since the freeze"; exit 1; }
   if (( N > 1 )); then p=$(printf '%s/batch-%02d' "$RUN" $((N - 1))); [[ -e "$p/closed" ]] || { echo "REFUSE: batch $((N - 1)) is not closed"; exit 1; }; fi
   mkdir -m 0700 "$A"   # fails if it exists: no clobber
   inventory "$A/inventory"
   python3 -I - "$RUN/run.manifest" "$N" "$BATCH" "$A" <<'PY'
import hashlib, json, os, sys, time
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[1])]; n, size, a = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
part = rows[(n - 1) * size:n * size]
if not part: sys.exit('REFUSE: no rows for this batch number')
inv = json.load(open(f'{a}/inventory/inventory.json'))
missing = {(r['hash16'], r['path']) for r in inv['rows'] if r['class'] in ('missing', 'missing-after-rollback')}
keep, drop = [], []
for h, sha, legacy, dated, day in part:
    path = dated if os.path.exists(dated) else legacy
    sid = os.path.basename(legacy).split('session-', 1)[1][:36]
    j = f'/root/.claude/projects/-root/{sid}.jsonl'
    why = ('not-missing' if (h, path) not in missing else
           'bytes-changed' if hashlib.sha256(open(path, 'rb').read()).hexdigest() != sha else
           'session-active' if os.path.exists(j) and time.time() - os.path.getmtime(j) < 1200 else None)
    (drop if why else keep).append((h, sha, legacy, dated, day, why))
open(f'{a}/members.tsv', 'w').write(''.join('\t'.join(r[:5]) + '\n' for r in keep))
open(f'{a}/dropped.tsv', 'w').write(''.join('\t'.join(r) + '\n' for r in drop))
print(f'slice {len(part)} rows: {len(keep)} kept, {len(drop)} dropped', {w: sum(1 for r in drop if r[5] == w) for w in {r[5] for r in drop}})
if not keep: sys.exit('REFUSE: every member dropped')
PY
   python3 -I "$OPS/date_parts.py" rename "$A/members.tsv" 1 "$(wc -l < "$A/members.tsv")" "$RUN/renames.tsv" --apply
   awk -F'\t' '{print $1"\t"$4}' "$A/members.tsv" > "$A/canary.manifest"; chmod 0444 "$A/canary.manifest" "$A/members.tsv"
   members_stable "$A"; echo "batch manifest $(wc -l < "$A/canary.manifest") pairs, sha256 $(sha "$A/canary.manifest")" ;;
V) step "verify the bridge for THIS batch: reviewed bytes, controls, 401/200, latch clear, route"
   stopped; A=$(bdir); open_batch "$A"; need "$A/canary.manifest"
   if dry; then echo "[dry-run] install/egress/process checks skipped (stub bridge)"; else
     python3 -I "$W/tools/chatgpt-plan-bridge/deploy/verify_install.py" "$W"
     for u in chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.timer; do s=$(systemctl is-active "$u" || true); echo "$u: $s"; [[ $s == active ]] || { echo "REFUSE: $u not active"; exit 1; }; done
     python3 -I "$W/tools/chatgpt-plan-bridge/deploy/verify_live.py" "$W"; fi
   code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/bridge/status" || true); [[ $code == 401 ]] || { echo "REFUSE: unauthenticated status=$code (want 401)"; exit 1; }
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); assert d.get("halted") is None, "bridge latch set"; assert d["routes"] == ["gpt-6-luna@medium"], d["routes"]; print("status 200, latch clear, routes", d["routes"])'
   date -u +%FT%TZ > "$A/V.ok" ;;
B) step "one real call through gbrain's gateway for THIS batch"
   stopped; A=$(bdir); open_batch "$A"; need "$A/V.ok"
   luna_env; out=$(bun "$OPS/real-call.ts"); echo "$out"
   python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); assert d["model"] and "luna" in d["model"], d["model"]; print("served", d["model"])' "$out"
   tail -1 "$LEDGER"; date -u +%FT%TZ > "$A/B.ok" ;;
F) step "write set BEFORE + preflight, bound to this batch's manifest"
   stopped; A=$(bdir); open_batch "$A"; need "$A/canary.manifest"; [[ ! -e "$A/before.json" ]] || { echo "REFUSE: before.json exists"; exit 1; }
   bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/before.json"
   bun "$OPS/writeset.ts" preflight "$A/before.json"
   (set -o noclobber; printf '%s %s\n' "$(sha "$A/before.json")" "$(sha "$A/canary.manifest")" > "$A/preflight.ok") ;;
G) step "OPEN (admission + corpus key), extract (one foreground owner), CLOSE, prove QUIESCED"
   stopped; A=$(bdir); open_batch "$A"; bindings "$A"; need "$A/V.ok" "$A/B.ok"; [[ ! -e "$A/run.json" ]] || { echo "REFUSE: this batch already ran"; exit 1; }
   no_runner; admission_is_closed || { echo "REFUSE: admission not closed before the run"; exit 1; }
   corpus_absent || { echo "REFUSE: corpus key present before OPEN"; exit 1; }
   bridge_status | python3 -I -c 'import json,sys; h=json.load(sys.stdin).get("halted"); print("bridge halted:", h); sys.exit(1 if h else 0)' || { echo "REFUSE: bridge latch set or status unavailable"; exit 1; }
   members_stable "$A" || { echo "REFUSE: a member changed after the batch freeze"; exit 1; }
   install -d -m 0700 "$A/checkout"; (set -o noclobber; date -u +%FT%TZ > "$A/T_start")
   # From here any exit that is not the normal end below closes admission, removes the corpus key and stops the run (§7.1).
   trap 'rc=$?; close_all; echo "unknown outcome: G exited $rc after OPEN" > "$RUN/STOP"; echo "HOLD (§7.1): G failed after OPEN (exit $rc); admission closed, corpus key removed, run stopped. No automatic rollback."; exit 3' EXIT
   gb config set cycle.extract_atoms.admit_hashes_file "$A/canary.manifest"
   [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$A/canary.manifest" ]] || { echo "admission readback mismatch"; exit 1; }
   gb config set dream.synthesize.session_corpus_dir "$CORPUS"
   luna_env; export GBRAIN_EXTRACT_PHASE_BUDGET_MS=3600000
   dream=(bun src/cli.ts dream --source default --dir "$A/checkout" --phase extract_atoms --json)
   [[ ${BATCH_DRYRUN_FAULT:-} == dream-exit ]] && dry && dream=(false)   # dry-run fault injection only
   set +e; (cd "$W" && set -o noclobber && "${dream[@]}" > "$A/run.json" 2> "$A/run.err"); rc=$?; set -e
   close_all; admission_is_closed && corpus_absent || { echo "ALERT: admission/corpus did not close"; exit 1; }
   trap - EXIT
   r=$(runners); live=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()" || echo unreadable)
   echo "CLOSED: admission closed, corpus key absent. runner processes: ${r:-none}; live cycle locks: $live"
   grep -E "admission manifest|\[extract_atoms\]" "$A/run.err" | tail -20 || true
   echo "dream rc=$rc"
   if [[ $rc != 0 || $live != 0 || -n $r ]]; then echo "unknown outcome: dream rc=$rc locks=$live runners=${r:-none}" > "$RUN/STOP"
     echo "HOLD (§7.1): unknown outcome. No automatic rollback; preserve everything and report to Nazz + Pebble."; exit 3; fi
   echo "QUIESCED: dream rc=0, no runner, no live lock" ;;
H) step "GATED (§4): write set AFTER, per-pair reconciliation, date gates, bridge rows, earlier batches unchanged"
   stopped; A=$(bdir); open_batch "$A"; bindings "$A"; need "$A/run.json"; [[ ! -e "$A/gated.ok" ]] || { echo "REFUSE: already gated"; exit 1; }
   rm -f "$A/after.json" "$A/plan.json"   # a re-run of H recaptures; nothing downstream trusts them without gated.ok
   bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/after.json" --like "$A/before.json"
   bun "$OPS/rollback-batch.ts" plan "$A/before.json" "$A/after.json" > "$A/plan.json"; cat "$A/plan.json"
   members_stable "$A" || { echo "GATE FAIL (§7.2): a member's bytes changed during the batch -> rollback"; exit 10; }
   set +e; python3 -I - "$A" "$(< "$A/T_start")" "$RUN" "$LEDGER" "$MODEL" <<'PY'
import glob, json, os, subprocess, sys
from collections import Counter, defaultdict
a, t0, run, ledger, model = sys.argv[1:6]
before, after, plan = (json.load(open(f'{a}/{f}')) for f in ('before.json', 'after.json', 'plan.json'))
day = {l.split('\t')[3]: l.rstrip('\n').split('\t')[4] for l in open(f'{a}/members.tsv')}
b = {x['id'] for x in before['atoms']}; new = [x for x in after['atoms'] if x['id'] not in b and not x['deleted_at']]
fails = []
if plan['plan']['changed_atoms'] or plan['changed_atom_ids']: fails.append(f"existing atoms changed: {plan['changed_atom_ids'][:5]}")
live = Counter(g['owner_key'] for g in after['generations'] if g['state'] == 'live')
if any(v > 1 for v in live.values()): fails.append('duplicate live generations')
by_pair = defaultdict(list)
for x in new: by_pair[x['pair']].append(x)
tomb = {(s['file_path'], s['content_hash']) for s in after['state_rows'] if s['tombstoned'] and int(s['fail_count']) == 0}
for p in after['pairs']:
    path, h = p['path'], p['hash16']; atoms = by_pair.get(path, [])
    gen = [g for g in after['generations'] if g['owner_key'] == p['ownerKey'] and g['state'] == 'live']
    if atoms and len(gen) != 1: fails.append(f'{os.path.basename(path)}: {len(atoms)} atoms but {len(gen)} live generations')
    if not atoms and (path, h) not in tomb:
        fails.append(f'{os.path.basename(path)}: neither a committed generation with atoms nor a native zero-atom tombstone')
    want = f'{day[path]}T00:00:00.000Z'
    for x in atoms:
        fm = x['frontmatter']
        if fm.get('source_hash') != h or fm.get('source_path') != path: fails.append(f"atom {x['id']}: provenance")
        if fm.get('date') != want or x.get('effective_date_source') != 'date' or (x.get('effective_date') or '')[:10] != day[path]:
            fails.append(f"atom {x['id']}: date {fm.get('date')} / {x.get('effective_date_source')} / {x.get('effective_date')} != {day[path]}")
        if x['slug'].split('/')[1] != day[path]: fails.append(f"atom {x['id']}: slug folder {x['slug']}")
        if not fm.get('extracted_model') or not fm.get('extracted_route'): fails.append(f"atom {x['id']}: no model provenance")
rows = [json.loads(l) for l in open(ledger) if l.strip()]
iso = lambda v: __import__('datetime').datetime.fromisoformat(v.replace('Z', '+00:00'))   # parsed: '...39.066Z' is after '...39Z'
rows = [r for r in rows if iso(r['ts']) >= iso(t0)]
codes = Counter(f"{r.get('status')}:{r.get('code', r.get('finish'))}" for r in rows)
if set(codes) - {'200:stop'}: fails.append(f'bridge rows not all 200:stop: {dict(codes)}')
served = Counter(x['frontmatter'].get('extracted_model') for x in new)
if set(served) - {model}: fails.append(f'served models: {dict(served)}')
for k in sorted(glob.glob(f'{run}/batch-*/kept.json')):   # earlier KEPT batches unchanged (ids, content hashes, liveness)
    kept = json.load(open(k)); ids = [r['id'] for r in kept]
    if not ids: continue
    out = subprocess.run(['psql', '-XAt', '-c', f"select id, content_hash, deleted_at is null from pages where id = any(array{ids}::bigint[]) order by id"], capture_output=True, text=True, check=True).stdout
    now = [l.split('|') for l in out.splitlines()]
    if [(int(i), c, v == 't') for i, c, v in now] != [(r['id'], r['content_hash'], True) for r in kept]: fails.append(f'{k}: an earlier kept batch changed')
print(json.dumps({'pairs': len(after['pairs']), 'pairs_with_atoms': len(by_pair), 'new_atoms': len(new), 'bridge_rows': len(rows), 'bridge_codes': dict(codes),
                  'served_models': dict(served), 'fails': fails[:20], 'fail_count': len(fails)}, indent=1))
sys.exit(10 if fails else 0)
PY
   g=$?; set -e
   [[ $g == 0 ]] || { echo "GATE FAIL (§7.2): no gated.ok -> rollback"; exit 10; }
   (set -o noclobber; printf '%s %s\n' "$(sha "$A/plan.json")" "$(sha "$A/after.json")" > "$A/gated.ok"); echo "GATED: PASS (gated.ok written)" ;;
K) step "blind kit of EVERY atom in this batch's write set"
   stopped; A=$(bdir); open_batch "$A"; bindings "$A"; gated "$A"
   python3 -I "$OPS/make_kit.py" "$A" ;;
S) step "score: seal both raters' labels; rating/PASS only if BOTH pass (§5, unchanged §8c)"
   stopped; A=$(bdir); open_batch "$A"; gated "$A"; R=$A/rating; rc=0; need "$R/key.json"
   for f in labels-r1.jsonl labels-r2-pebble.jsonl; do need "$R/$f"; chmod 0444 "$R/$f"; sha256sum "$R/$f"; done
   for f in labels-r1.jsonl labels-r2-pebble.jsonl; do
     echo "== $f"; set +e; python3 -I "$OPS/score.py" "$R/key.json" "$R/$f"; r=$?; set -e
     [[ $r == 0 || $r == 10 ]] || { echo "STOP: $f was not scored (exit $r): fix the labels or the kit, never the score"; exit 2; }; [[ $r == 0 ]] || rc=1
   done
   if [[ $rc == 0 ]]; then (set -o noclobber; date -u +%FT%TZ > "$R/PASS"); echo "RATING: PASS -> keep"; else echo "RATING: FAIL -> rollback"; fi
   exit $rc ;;
keep) step "KEPT: requires gated.ok and (rating PASS, or zero atoms); records the atoms for later batches' checks"
   stopped; A=$(bdir); open_batch "$A"; bindings "$A"; gated "$A"
   new=$(python3 -I -c "import json,sys;print(len(json.load(open(sys.argv[1]))['new_atom_ids']))" "$A/plan.json")
   [[ $new == 0 || -s "$A/rating/PASS" ]] || { echo "REFUSE: no rating PASS (an empty batch alone is decided by the gates)"; exit 1; }
   python3 -I - "$A" <<'PY'
import json, sys
a = sys.argv[1]; ids = set(json.load(open(f'{a}/plan.json'))['new_atom_ids'])
after = json.load(open(f'{a}/after.json'))
kept = sorted(({'id': x['id'], 'content_hash': x['content_hash']} for x in after['atoms'] if x['id'] in ids), key=lambda r: r['id'])
assert len(kept) == len(ids), 'plan ids missing from after.json'
json.dump(kept, open(f'{a}/kept.json', 'x')); print('kept', len(kept), 'atoms')
PY
   (set -o noclobber; echo "kept $(date -u +%FT%TZ)" > "$A/closed") ;;
rollback) step "known FAIL (§7.2), or a decided HOLD: scoped rollback of THIS batch, receipt recorded, run stops"
   A=$(bdir); open_batch "$A"; bindings "$A"
   close_all; admission_is_closed && corpus_absent || { echo "REFUSE: cannot close admission / remove the corpus key"; exit 1; }
   no_runner
   [[ -e "$A/after.json" && -e "$A/gated.ok" ]] || bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/after.json.rb" --like "$A/before.json"
   AF="$A/after.json"; [[ -e "$A/after.json.rb" ]] && AF="$A/after.json.rb"
   bun "$OPS/rollback-batch.ts" plan "$A/before.json" "$AF" > "$A/rollback-plan.json"
   bun "$OPS/rollback-batch.ts" apply "$A/before.json" "$AF"
   bun "$OPS/rollback-batch.ts" verify "$A/before.json" "$AF" > "$A/rollback-verify.json"   # exits 0 only on DONE
   python3 -I - "$A" "$AF" "$RUN/receipts/batch-$(printf %02d "$N").json" <<'PY'
import hashlib, json, sys
a, af, out = sys.argv[1:4]
r = {'batch_dir': a, 'before': f'{a}/before.json', 'after': af,
     'before_sha256': hashlib.sha256(open(f'{a}/before.json', 'rb').read()).hexdigest(),
     'after_sha256': hashlib.sha256(open(af, 'rb').read()).hexdigest(),
     'plan': json.load(open(f'{a}/rollback-plan.json')), 'verify': json.load(open(f'{a}/rollback-verify.json'))}
assert r['verify'].get('verdict') == 'DONE'
open(out, 'x').write(json.dumps(r, indent=1)); print('receipt', out, hashlib.sha256(open(out, 'rb').read()).hexdigest())
PY
   (set -o noclobber; echo "rolled-back $(date -u +%FT%TZ)" > "$A/closed"); echo "batch $N rolled back" >> "$RUN/STOP"
   echo "run STOPPED (§7.2). Next: 'end', report to Nazz + Pebble." ;;
end) step "end of run: admission closed, corpus key absent, autopilot restarted, final inventory"
   close_all; admission_is_closed && corpus_absent || { echo "REFUSE: cannot close admission / remove the corpus key"; exit 1; }
   no_runner
   svc start gbrain-autopilot.service; if ! dry; then [[ $(systemctl is-active gbrain-autopilot.service) == active ]] || { echo "ALERT: autopilot did not start"; exit 1; }; fi
   inventory "$RUN/end-inventory" ;;
*) echo "unknown step $STEP"; exit 2 ;;
esac
