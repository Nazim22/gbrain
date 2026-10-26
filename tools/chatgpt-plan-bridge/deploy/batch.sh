#!/bin/bash
# Luna stage 2 catch-up (STAGE2-DESIGN r2 18a291d1). ONE step per invocation, output in full:
#   batch.sh <converter|freeze|V|B|C|D> <reviewed-head-full-sha>
#   batch.sh <E|F|G|H|K|S|keep|rollback> <reviewed-head-full-sha> <batch-no>
#   batch.sh end <reviewed-head-full-sha>
# Run order under the single GO (§8): converter, freeze, V, B, C, D, then per batch E F G H K S keep (or rollback, which
# stops the run), then end. Every step refuses unless the worktree is clean at exactly <reviewed-head>; its src/ is the
# gbrain runtime for D-H. A batch dir has the canary attempt layout (canary.manifest, before.json, preflight.ok, ...), so
# writeset.ts, rollback-batch.ts, make_kit.py and score.py are reused unchanged. Live autopilot stays stopped from C to end.
set -euo pipefail
STEP=${1:?step} WANT=${2:?reviewed head} N=${3:-}
W=/root/work/gbrain-s552-luna-bridge OPS=$W/tools/chatgpt-plan-bridge/ops RUN=/root/work/dream-s552-luna/stage2-run DB=gbrain_pingu
CONV_LIVE=/root/.gbrain/ingest-session-transcript.py CONV_NEW=$W/tools/chatgpt-plan-bridge/ingest/ingest-session-transcript.py
CONV_BASE_SHA=425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d   # the vendored base (commit 2e819086)
BATCH=100 CORPUS=/root/.claude/projects/-root/session-text PORT=18795 ROUTE='litellm:gpt-6-luna@medium'
CFG=/root/.gbrain/config.json
[[ $(git -C "$W" rev-parse HEAD) == "$WANT" && -z $(git -C "$W" status --porcelain) ]] || { echo "REFUSE: $W is not clean at $WANT"; exit 1; }
source /root/.gbrain/pg.env
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE="$DB" PGPASSWORD="$PASS"   # environment only, never argv
export DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/$DB"
gb() { (cd "$W" && bun src/cli.ts "$@"); }
q() { psql -XAt -v ON_ERROR_STOP=1 -F ' | ' -c "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
step() { echo "=== $(date -u +%FT%TZ) $STEP${N:+ batch $N}: $*"; }
luna_env() { export LITELLM_BASE_URL="http://127.0.0.1:$PORT/v1"; export LITELLM_API_KEY="$(< /etc/chatgpt-plan-bridge/caller.secret)"; }
bridge_status() { printf 'header = "Authorization: Bearer %s"\n' "$(< /etc/chatgpt-plan-bridge/caller.secret)" | curl -sS -f -K - "http://127.0.0.1:$PORT/v1/bridge/status"; }
no_runner() { if pgrep -af 'gbrain (autopilot|dream|cycle)|src/cli.ts (autopilot|dream|cycle)'; then echo "REFUSE: a gbrain runner process exists"; exit 1; fi; }
db_count() { local n; n=$(q "select count(*) from config where key='$1'") || { echo "REFUSE: config query failed for $1" >&2; exit 1; }; [[ $n =~ ^[0-9]+$ ]] || { echo "REFUSE: bad count '$n'" >&2; exit 1; }; echo "$n"; }
db_value() { local v; v=$(q "select value from config where key='$1'") || { echo "REFUSE: config query failed for $1" >&2; exit 1; }; echo "$v"; }
file_has_corpus() { python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print(1 if (c.get("dream") or {}).get("synthesize",{}).get("session_corpus_dir") else 0)' "$CFG"; }
disable_extraction() {
  gb config unset dream.synthesize.session_corpus_dir || echo "(unset reported failure; verifying state)"
  local n f; n=$(db_count dream.synthesize.session_corpus_dir); f=$(file_has_corpus)
  [[ $n == 0 && $f == 0 ]] || { echo "REFUSE: corpus key still present (db=$n file=$f)"; exit 1; }
  echo "extraction disabled: corpus key absent (db=0 file=0)"
}
install -d -m 0700 "$RUN" "$RUN/receipts"; [[ -e "$RUN/closed.manifest" ]] || : > "$RUN/closed.manifest"
[[ ! -s "$RUN/closed.manifest" ]] || { echo "REFUSE: closed.manifest is not empty"; exit 1; }
admission_is_closed() { [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$RUN/closed.manifest" ]]; }
stopped() { [[ ! -e "$RUN/STOP" ]] || { echo "REFUSE: the run is stopped ($(< "$RUN/STOP")); only 'end' remains"; exit 1; }; }
inventory() {   # fresh read-only inventory with both names + verified receipts; the missing list feeds plan / drop-only checks
  bun "$OPS/inventory.ts" "$CORPUS" "$1" "$RUN/renames.tsv" "$RUN/receipts" > "$1.out"
  python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print('inventory:',d['discovered'],d['counts'],'independent_live_paths',d['independent_live_paths'])" "$1.out"
}
bdir() { [[ $N =~ ^[0-9]+$ && $N -ge 1 ]] || { echo "REFUSE: batch number required" >&2; exit 1; }; printf '%s/batch-%02d' "$RUN" "$N"; }
bindings() {   # canary.manifest -> before.json -> preflight.ok must agree, or refuse
  local A=$1 m b f; for f in canary.manifest before.json preflight.ok; do [[ -s "$A/$f" ]] || { echo "REFUSE: $A/$f missing"; exit 1; }; done
  m=$(sha "$A/canary.manifest"); b=$(sha "$A/before.json")
  [[ $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifest_sha256"])' "$A/before.json") == "$m" ]] || { echo "REFUSE: before.json is not bound to this manifest"; exit 1; }
  [[ $(< "$A/preflight.ok") == "$b $m" ]] || { echo "REFUSE: preflight.ok does not bind this before.json + manifest"; exit 1; }
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
converter) step "install the reviewed converter (it must be live before any rename, §1)"
   [[ $(sha "$CONV_LIVE") == "$CONV_BASE_SHA" || $(sha "$CONV_LIVE") == $(sha "$CONV_NEW") ]] || { echo "REFUSE: installed converter is neither the reviewed base nor the candidate"; exit 1; }
   [[ -e "$RUN/converter.base.py" ]] || cp -p "$CONV_LIVE" "$RUN/converter.base.py"
   install -m 0755 "$CONV_NEW" "$CONV_LIVE.tmp" && mv "$CONV_LIVE.tmp" "$CONV_LIVE"
   [[ $(sha "$CONV_LIVE") == $(sha "$CONV_NEW") ]] || { echo "ALERT: installed bytes differ"; exit 1; }
   echo "converter live: $(sha "$CONV_LIVE") (base kept at $RUN/converter.base.py)" ;;
freeze) step "run freeze (§3a): one finite run.manifest, the GO binds its sha256"
   [[ ! -e "$RUN/run.manifest" ]] || { echo "REFUSE: the run is already frozen"; exit 1; }
   [[ $(sha "$CONV_LIVE") == $(sha "$CONV_NEW") ]] || { echo "REFUSE: the reviewed converter is not live (run 'converter')"; exit 1; }
   inventory "$RUN/freeze-inventory"
   python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));[print(r['hash16']+'\t'+r['path']) for r in d['rows'] if r['class'] in ('missing','missing-after-rollback')]" "$RUN/freeze-inventory/inventory.json" > "$RUN/eligible.manifest"
   python3 -I "$OPS/date_parts.py" plan "$RUN/eligible.manifest" "$RUN/run.manifest" "$RUN/refused.tsv"
   cut -f3 "$RUN/refused.tsv" | sort | uniq -c
   chmod 0444 "$RUN/run.manifest"; n=$(wc -l < "$RUN/run.manifest")
   echo "run.manifest rows $n -> $(( (n + BATCH - 1) / BATCH )) batches of <= $BATCH; sha256 $(sha "$RUN/run.manifest")"
   sha "$RUN/run.manifest" > "$RUN/run.manifest.sha256" ;;
V) step "verify the installed bridge is the reviewed bytes, controls intact"
   python3 -I "$W/tools/chatgpt-plan-bridge/deploy/verify_install.py" "$W"
   for u in chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.timer; do s=$(systemctl is-active "$u" || true); echo "$u: $s"; [[ $s == active ]] || { echo "REFUSE: $u not active"; exit 1; }; done
   python3 -I "$W/tools/chatgpt-plan-bridge/deploy/verify_live.py" "$W"
   code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/bridge/status"); [[ $code == 401 ]] || { echo "REFUSE: unauthenticated status=$code"; exit 1; }
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); assert d.get("halted") is None, "bridge latch set"; assert d["routes"] == ["gpt-6-luna@medium"], d["routes"]; print("status 200, latch clear, routes", d["routes"])' ;;
B) step "one real call through gbrain's gateway (synthetic prompt)"
   luna_env; bun "$OPS/real-call.ts"; tail -1 /srv/chatgpt-plan-bridge/state/requests.jsonl ;;
C) step "pause competing runners for the whole run (single owner)"
   systemctl stop gbrain-autopilot.service
   for u in gbrain-autopilot.service gbrain-dream.timer; do s=$(systemctl is-active "$u" || true); echo "$u: $s"; [[ $s != active ]] || { echo "REFUSE: $u active"; exit 1; }; done
   no_runner; live=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()"); echo "live cycle locks: $live"; [[ $live == 0 ]] || exit 1 ;;
D) step "config: synthesize off, route, admission CLOSED, then corpus key"
   gb config set dream.synthesize.enabled false; gb config set models.dream.extract_atoms "$ROUTE"
   gb config set cycle.extract_atoms.admit_hashes_file "$RUN/closed.manifest"; admission_is_closed || { echo "REFUSE: admission not closed"; exit 1; }
   gb config set dream.synthesize.session_corpus_dir "$CORPUS"
   for k in dream.synthesize.enabled models.dream.extract_atoms cycle.extract_atoms.admit_hashes_file dream.synthesize.session_corpus_dir; do echo "$k = $(db_value $k)"; done ;;
E) step "batch freeze: drop-only re-check of this slice, renames, batch manifest"
   stopped; A=$(bdir); [[ -s "$RUN/run.manifest" ]] || { echo "REFUSE: no run freeze"; exit 1; }
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
F) step "write set BEFORE + preflight, bound to this batch's manifest"
   stopped; A=$(bdir); [[ ! -e "$A/before.json" ]] || { echo "REFUSE: before.json exists"; exit 1; }
   bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/before.json"
   bun "$OPS/writeset.ts" preflight "$A/before.json"
   (set -o noclobber; printf '%s %s\n' "$(sha "$A/before.json")" "$(sha "$A/canary.manifest")" > "$A/preflight.ok") ;;
G) step "OPEN to this manifest, extract (one foreground owner), prove QUIESCED, CLOSE"
   stopped; A=$(bdir); bindings "$A"; [[ ! -e "$A/run.json" ]] || { echo "REFUSE: this batch already ran"; exit 1; }
   no_runner; admission_is_closed || { echo "REFUSE: admission not closed before the run"; exit 1; }
   bridge_status | python3 -I -c 'import json,sys; h=json.load(sys.stdin).get("halted"); print("bridge halted:", h); sys.exit(1 if h else 0)' || { echo "REFUSE: bridge latch set or status unavailable"; exit 1; }
   members_stable "$A" || { echo "REFUSE: a member changed after the batch freeze (re-run E for a new batch)"; exit 1; }
   install -d -m 0700 "$A/checkout"; (set -o noclobber; date -u +%FT%TZ > "$A/T_start")
   gb config set cycle.extract_atoms.admit_hashes_file "$A/canary.manifest"
   [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$A/canary.manifest" ]] || { echo "REFUSE: admission readback mismatch"; exit 1; }
   luna_env; export GBRAIN_EXTRACT_PHASE_BUDGET_MS=3600000
   set +e; (cd "$W" && set -o noclobber && bun src/cli.ts dream --source default --dir "$A/checkout" --phase extract_atoms --json > "$A/run.json" 2> "$A/run.err"); rc=$?; set -e
   gb config set cycle.extract_atoms.admit_hashes_file "$RUN/closed.manifest"
   admission_is_closed || { echo "ALERT: admission did not close; close it by hand before anything else"; exit 1; }
   # QUIESCED (§3): the only writer has exited; no runner, no live cycle lock, live runners still stopped.
   runners=$(pgrep -af 'gbrain (autopilot|dream|cycle)|src/cli.ts (autopilot|dream|cycle)' || true); echo "runner processes: ${runners:-none}"
   live=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()" || echo unreadable); echo "live cycle locks: $live"
   for u in gbrain-autopilot.service gbrain-dream.timer; do echo "$u: $(systemctl is-active "$u" || true)"; done
   grep -E "admission manifest|\[extract_atoms\]" "$A/run.err" | tail -20 || true
   bridge_status | python3 -I -c 'import json,sys; print("bridge halted after run:", json.load(sys.stdin).get("halted"))' || echo "bridge status unavailable"
   echo "dream rc=$rc"
   if [[ $rc != 0 || $live != 0 || -n $runners ]]; then echo "unknown outcome: dream rc=$rc locks=$live runners=${runners:-none}" > "$RUN/STOP"
     echo "HOLD (§7.1): unknown outcome. No automatic rollback. Admission is closed; preserve everything and report to Nazz + Pebble."; exit 3; fi ;;
H) step "GATED (§4): write set AFTER + per-pair reconciliation + date gates + bridge rows + earlier batches unchanged"
   stopped; A=$(bdir); bindings "$A"; [[ -e "$A/run.json" ]] || { echo "REFUSE: G has not run"; exit 1; }
   bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/after.json" --like "$A/before.json"
   bun "$OPS/rollback-batch.ts" plan "$A/before.json" "$A/after.json" | (set -o noclobber; tee "$A/plan.json")
   members_stable "$A" || { echo "FAIL (§7.2): a member's bytes changed during the batch"; exit 10; }
   python3 -I - "$A" "$(< "$A/T_start")" "$RUN" "$N" <<'PY'
import glob, json, os, sys
from collections import Counter, defaultdict
a, t0, run, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
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
rows = [json.loads(l) for l in open('/srv/chatgpt-plan-bridge/state/requests.jsonl') if l.strip()]
rows = [r for r in rows if r['ts'] >= t0]
codes = Counter(f"{r.get('status')}:{r.get('code', r.get('finish'))}" for r in rows)
if set(codes) - {'200:stop'}: fails.append(f'bridge rows not all 200:stop: {dict(codes)}')
served = Counter(x['frontmatter'].get('extracted_model') for x in new)
if set(served) - {'gpt-6-luna'}: fails.append(f'served models: {dict(served)}')
# Earlier KEPT batches unchanged (their atom ids, content hashes, liveness).
import subprocess
for k in sorted(glob.glob(f'{run}/batch-*/kept.json')):
    kept = json.load(open(k)); ids = [r['id'] for r in kept]
    out = subprocess.run(['psql', '-XAt', '-c', f"select id, content_hash, deleted_at is null from pages where id = any(array{ids}::bigint[]) order by id"], capture_output=True, text=True, check=True).stdout
    now = [dict(zip(('id', 'content_hash', 'live'), l.split('|'))) for l in out.splitlines()]
    if [(int(r['id']), r['content_hash'], r['live'] == 't') for r in now] != [(r['id'], r['content_hash'], True) for r in kept]: fails.append(f'{k}: an earlier kept batch changed')
print(json.dumps({'pairs': len(after['pairs']), 'pairs_with_atoms': len(by_pair), 'new_atoms': len(new), 'bridge_rows': len(rows), 'bridge_codes': dict(codes),
                  'served_models': dict(served), 'fails': fails[:20], 'fail_count': len(fails)}, indent=1))
sys.exit(10 if fails else 0)
PY
   echo "GATED: PASS" ;;
K) step "blind kit of EVERY atom in this batch's write set"
   stopped; A=$(bdir); bindings "$A"; [[ -s "$A/plan.json" && -s "$A/after.json" ]] || { echo "REFUSE: H has not run"; exit 1; }
   python3 -I "$OPS/make_kit.py" "$A" ;;
S) step "score: seal both raters' labels; rating/PASS only if BOTH pass (§5, unchanged §8c)"
   stopped; A=$(bdir); R=$A/rating; rc=0; [[ -s $R/key.json ]] || { echo "REFUSE: no kit (run K)"; exit 1; }
   for f in labels-r1.jsonl labels-r2-pebble.jsonl; do [[ -s $R/$f ]] || { echo "REFUSE: $R/$f missing"; exit 1; }; chmod 0444 "$R/$f"; sha256sum "$R/$f"; done
   for f in labels-r1.jsonl labels-r2-pebble.jsonl; do
     echo "== $f"; set +e; python3 -I "$OPS/score.py" "$R/key.json" "$R/$f"; r=$?; set -e
     [[ $r == 0 || $r == 10 ]] || { echo "STOP: $f was not scored (exit $r): fix the labels or the kit, never the score"; exit 2; }; [[ $r == 0 ]] || rc=1
   done
   if [[ $rc == 0 ]]; then (set -o noclobber; date -u +%FT%TZ > "$R/PASS"); echo "RATING: PASS -> keep"; else echo "RATING: FAIL -> rollback"; fi
   exit $rc ;;
keep) step "KEPT: record this batch's atoms so later batches prove them unchanged"
   stopped; A=$(bdir); bindings "$A"; [[ -s "$A/plan.json" ]] || { echo "REFUSE: H has not run"; exit 1; }
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
rollback) step "known FAIL (§7.2): scoped rollback of THIS batch, receipt recorded, run stops"
   A=$(bdir); bindings "$A"
   gb config set cycle.extract_atoms.admit_hashes_file "$RUN/closed.manifest"; admission_is_closed || { echo "REFUSE: cannot close admission"; exit 1; }
   no_runner
   [[ -e "$A/after.json" ]] || bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/after.json" --like "$A/before.json"
   bun "$OPS/rollback-batch.ts" plan "$A/before.json" "$A/after.json" > "$A/rollback-plan.json"
   bun "$OPS/rollback-batch.ts" apply "$A/before.json" "$A/after.json"
   bun "$OPS/rollback-batch.ts" verify "$A/before.json" "$A/after.json" > "$A/rollback-verify.json"   # exits 0 only on DONE
   python3 -I - "$A" "$RUN/receipts/batch-$(printf %02d "$N").json" <<'PY'
import hashlib, json, sys
a, out = sys.argv[1], sys.argv[2]
r = {'batch_dir': a, 'before_sha256': hashlib.sha256(open(f'{a}/before.json', 'rb').read()).hexdigest(),
     'after_sha256': hashlib.sha256(open(f'{a}/after.json', 'rb').read()).hexdigest(),
     'plan': json.load(open(f'{a}/rollback-plan.json')), 'verify': json.load(open(f'{a}/rollback-verify.json'))}
assert r['verify'].get('verdict') == 'DONE'
open(out, 'x').write(json.dumps(r, indent=1)); print('receipt', out, hashlib.sha256(open(out, 'rb').read()).hexdigest())
PY
   (set -o noclobber; echo "rolled-back $(date -u +%FT%TZ)" > "$A/closed"); echo "batch $N rolled back" > "$RUN/STOP"
   echo "run STOPPED (§7.2). Next: 'end', report to Nazz + Pebble." ;;
end) step "end of run: admission closed, extraction disabled for the unpatched live autopilot, autopilot restarted, final inventory"
   gb config set cycle.extract_atoms.admit_hashes_file "$RUN/closed.manifest"; admission_is_closed || { echo "REFUSE: cannot close admission"; exit 1; }
   no_runner; disable_extraction
   systemctl start gbrain-autopilot.service; systemctl is-active gbrain-autopilot.service
   inventory "$RUN/end-inventory" ;;
*) echo "unknown step $STEP"; exit 2 ;;
esac
