#!/bin/bash
# Luna canary, stage 1 (CANARY-PACKET.md; DESIGN.md r4 fae517a8). ONE step per invocation, output in full:
#   canary.sh <A|V|B|C|D|E|F|G|H|I|K|S|resume|rollback> <reviewed-head-full-sha>
# A installs the bridge; V instead binds an ALREADY-installed bridge to these reviewed bytes. K builds the blind kit from the
# attempt's atom write set; S scores both raters' sealed labels and writes rating/PASS only if both pass (resume requires it).
# Every step refuses unless the worktree is clean at exactly <reviewed-head>; that worktree's src/ IS the gbrain runtime
# for D–H (bun $W/src/cli.ts) and its tools/ is the bridge installed in A. Live autopilot stays stopped from C until
# 'resume' (acceptance PASS) or a DONE-verified 'rollback'.
# Attempts: E creates a fresh no-clobber attempt dir (and refuses while a previous attempt is open); F–I, resume and
# rollback act only on that attempt, and verify the chain manifest -> before.json -> preflight.ok -> run -> after.json.
set -euo pipefail
STEP=${1:?step} WANT=${2:?reviewed head}
W=/root/work/gbrain-s552-luna-bridge OPS=$W/tools/chatgpt-plan-bridge/ops D=/root/work/dream-s552-luna/canary DB=gbrain_pingu
# DRY RUN (tests only): CANARY_DRYRUN=1 with CANARY_DB=gbrain_s552_* + CANARY_DIR + GBRAIN_HOME (scratch): every systemctl
# becomes a printed no-op and nothing touches the live DB, home or services. Refused for any non-scratch database.
if [[ ${CANARY_DRYRUN:-} == 1 ]]; then
  [[ ${CANARY_DB:-} == gbrain_s552_* && -n ${CANARY_DIR:-} && -n ${GBRAIN_HOME:-} ]] || { echo "REFUSE: dry run needs CANARY_DB=gbrain_s552_*, CANARY_DIR, GBRAIN_HOME"; exit 1; }
  DB=$CANARY_DB D=$CANARY_DIR
fi
CFG="${GBRAIN_HOME:-/root}/.gbrain/config.json"   # the file plane of the gbrain home in use (GBRAIN_HOME is the parent of .gbrain/, like HOME)
# A gbrain runner PROCESS on this host. In a dry run the live autopilot does not touch the scratch DB, so only the
# scratch DB's cycle-lock check applies there.
no_runner() { if [[ ${CANARY_DRYRUN:-} == 1 ]]; then echo "[dry-run] process check skipped (live runners do not use $DB)"; return 0; fi
  if pgrep -af 'gbrain (autopilot|dream|cycle)'; then echo "REFUSE: a gbrain runner process exists"; exit 1; fi; }
svc() { if [[ ${CANARY_DRYRUN:-} == 1 ]]; then echo "[dry-run] systemctl $*"; else systemctl "$@"; fi; }
CORPUS=/root/.claude/projects/-root/session-text PORT=18795 ROUTE='litellm:gpt-6-luna@medium' GEMMA='llama-server:gemma-4-12b-qat'
[[ ${CANARY_DRYRUN:-} != 1 ]] || PORT=1   # a dry run never reaches the live bridge (closed port: no real call, G refuses)
[[ $(git -C "$W" rev-parse HEAD) == "$WANT" && -z $(git -C "$W" status --porcelain) ]] || { echo "REFUSE: $W is not clean at $WANT"; exit 1; }
source /root/.gbrain/pg.env
# libpq reads these from the ENVIRONMENT (no password on any argv); PGDATABASE is a plain name, never a URI.
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE="$DB" PGPASSWORD="$PASS"
export DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/$DB"   # environment only, read by the bun tools
gb() { (cd "$W" && bun src/cli.ts "$@"); }
q() { psql -XAt -v ON_ERROR_STOP=1 -F ' | ' -c "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
step() { echo "=== $(date -u +%FT%TZ) $STEP: $*"; }
luna_env() { export LITELLM_BASE_URL="http://127.0.0.1:$PORT/v1"; export LITELLM_API_KEY="$(< /etc/chatgpt-plan-bridge/caller.secret)"; }
bridge_status() { printf 'header = "Authorization: Bearer %s"\n' "$(< /etc/chatgpt-plan-bridge/caller.secret)" | curl -sS -f -K - "http://127.0.0.1:$PORT/v1/bridge/status"; }
install -d -m 0700 "$D"; [[ -e "$D/closed.manifest" ]] || : > "$D/closed.manifest"
[[ ! -s "$D/closed.manifest" ]] || { echo "REFUSE: closed.manifest is not empty"; exit 1; }

# A key's DB row count, from a query whose own failure stops the script (never an empty stdout read as "absent").
db_count() { local n; n=$(q "select count(*) from config where key='$1'") || { echo "REFUSE: config query failed for $1" >&2; exit 1; }; [[ $n =~ ^[0-9]+$ ]] || { echo "REFUSE: bad count '$n'" >&2; exit 1; }; echo "$n"; }
db_value() { local v; v=$(q "select value from config where key='$1'") || { echo "REFUSE: config query failed for $1" >&2; exit 1; }; echo "$v"; }
file_has_corpus() { python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); print(1 if (c.get("dream") or {}).get("synthesize",{}).get("session_corpus_dir") else 0)' "$CFG"; }
# The live autopilot runs the UNPATCHED binary (no admission manifest): before it may run, extraction is disabled the way
# live had it — corpus key absent in BOTH planes — verified by successful queries.
disable_extraction() {
  gb config unset dream.synthesize.session_corpus_dir || echo "(unset reported failure; verifying state)"
  local n f; n=$(db_count dream.synthesize.session_corpus_dir); f=$(file_has_corpus)
  [[ $n == 0 && $f == 0 ]] || { echo "REFUSE: corpus key still present (db=$n file=$f)"; exit 1; }
  echo "extraction disabled: corpus key absent (db=0 file=0)"
}
admission_is_closed() { [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$D/closed.manifest" ]]; }

# Attempt handling
attempt() { [[ -s "$D/ATTEMPT" ]] || { echo "REFUSE: no current attempt (run E)" >&2; exit 1; }; local a; a=$(< "$D/ATTEMPT"); [[ -d $a && $a == "$D"/attempt-* ]] || { echo "REFUSE: bad attempt pointer" >&2; exit 1; }; echo "$a"; }
bindings() {   # manifest -> before.json -> preflight.ok must agree, or refuse
  local A=$1 m b f; for f in canary.manifest before.json preflight.ok; do [[ -s "$A/$f" ]] || { echo "REFUSE: $A/$f missing (run E then F)"; exit 1; }; done
  m=$(sha "$A/canary.manifest"); b=$(sha "$A/before.json")
  [[ $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifest_sha256"])' "$A/before.json") == "$m" ]] || { echo "REFUSE: before.json is not bound to this manifest"; exit 1; }
  [[ $(< "$A/preflight.ok") == "$b $m" ]] || { echo "REFUSE: preflight.ok does not bind this before.json + manifest"; exit 1; }
}

case "$STEP" in
A) step "install the bridge service from $WANT"
   bash "$W/tools/chatgpt-plan-bridge/deploy/install.sh" "$W" "$WANT" ;;
V) step "verify the INSTALLED bridge is these reviewed bytes and its controls are intact (reuse instead of A)"
   python3 -I "$W/tools/chatgpt-plan-bridge/deploy/verify_install.py" "$W"
   for u in chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.timer; do s=$(systemctl is-active "$u" || true); echo "$u: $s"; [[ $s == active ]] || { echo "REFUSE: $u not active"; exit 1; }; done
   python3 -I "$W/tools/chatgpt-plan-bridge/deploy/verify_live.py" "$W"     # effective egress confinement + running process identity
   code=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/bridge/status"); [[ $code == 401 ]] || { echo "REFUSE: unauthenticated status=$code (want 401)"; exit 1; }; echo "no-secret status=401 OK"
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); assert d.get("halted") is None, "bridge latch set"; assert d["routes"] == ["gpt-6-luna@medium"], d["routes"]; print("with-secret status=200 OK, latch clear, routes", d["routes"])' ;;
B) step "one real call through gbrain's gateway (synthetic prompt)"
   luna_env; bun "$OPS/real-call.ts"
   echo "last bridge ledger row (no text by design):"; tail -1 /srv/chatgpt-plan-bridge/state/requests.jsonl ;;
C) step "pause competing runners (single owner)"
   svc stop gbrain-autopilot.service
   for u in gbrain-autopilot.service gbrain-dream.timer; do s=$(svc is-active "$u" || true); echo "$u: $s"; [[ $s != active ]] || { echo "REFUSE: $u active"; exit 1; }; done
   no_runner
   live=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()"); echo "live cycle locks: $live"; [[ $live == 0 ]] || exit 1 ;;
D) step "config: synthesize off, route, admission CLOSED, then corpus key; pricing; file-plane base url"
   gb config set dream.synthesize.enabled false
   gb config set models.dream.extract_atoms "$ROUTE"
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"
   admission_is_closed || { echo "REFUSE: admission not closed after set"; exit 1; }
   gb config set dream.synthesize.session_corpus_dir "$CORPUS"
   for k in dream.synthesize.enabled models.dream.extract_atoms cycle.extract_atoms.admit_hashes_file dream.synthesize.session_corpus_dir; do echo "$k = $(db_value $k)"; done
   gb pricing set "$ROUTE" --input 0 --output 0 --source "subscription: ChatGPT Pro via Sign in with ChatGPT (owner-verified allowance, Nazz 2026-10-26)"
   [[ -e "$D/config.json.before" ]] || cp -p "$CFG" "$D/config.json.before"
   python3 -I - "$PORT" "$CFG" <<'PY'
import json, sys, os
p = sys.argv[2]; c = json.load(open(p)); c.setdefault('provider_base_urls', {})['litellm'] = f'http://127.0.0.1:{sys.argv[1]}/v1'
tmp = p + '.tmp'; json.dump(c, open(tmp, 'w'), indent=2); os.chmod(tmp, 0o600); os.replace(tmp, p); print('provider_base_urls.litellm =', c['provider_base_urls']['litellm'])
PY
   ;;
E) step "new attempt: fresh read-only inventory; manifest = 20 MISSING never exposed by an earlier attempt, lowest sha256(hash16)"
   if [[ -s "$D/ATTEMPT" ]]; then prev=$(< "$D/ATTEMPT"); [[ -e "$prev/closed" ]] || { echo "REFUSE: previous attempt $prev is still open (resume or rollback it)"; exit 1; }; fi
   A="$D/attempt-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -m 0700 "$A"            # fails if it exists: no clobber
   # set -e does not apply inside an if-tested function: every step returns explicitly. On failure the new (empty of any
   # manifest) attempt dir is removed so it can never read as malformed history; earlier attempts are never touched.
   new_manifest() {
     bun "$OPS/inventory.ts" "$CORPUS" "$A/inventory" > "$A/inventory.out" || return 1
     python3 -I -c "import json;d=json.load(open('$A/inventory.out'));print(d['discovered'],d['counts'])" || return 1
     python3 -I - "$A" <<'PY' || return 1
import glob, hashlib, os, re, sys
a = sys.argv[1]; rows = [l.rstrip('\n').split('\t') for l in open(f'{a}/inventory/missing.manifest') if l.strip()]
# Freshness: every part an earlier attempt exposed (by hash AND by path, so a re-written source counts too) is excluded.
# Fail closed: an earlier attempt dir without a readable, well-formed, non-empty canary.manifest stops E.
seen_h, seen_p, prior = set(), set(), 0
for m in sorted(glob.glob(os.path.join(os.path.dirname(a), 'attempt-*'))):
    if os.path.realpath(m) == os.path.realpath(a): continue
    lines = open(os.path.join(m, 'canary.manifest')).read().splitlines(); prior += 1
    if not lines: sys.exit(f'REFUSE: empty history manifest in {m}')
    for l in lines:
        f = l.split('\t')
        if len(f) != 2 or not re.fullmatch(r'[0-9a-f]{16}', f[0]) or not f[1].startswith('/'): sys.exit(f'REFUSE: malformed history line in {m}: {l!r}')
        seen_h.add(f[0]); seen_p.add(f[1])
elig = [r for r in rows if r[0] not in seen_h and r[1] not in seen_p]
print(f'history: {prior} earlier attempt(s), {len(seen_h)} parts exposed; {len(rows) - len(elig)} of {len(rows)} MISSING excluded; {len(elig)} eligible')
if len(elig) < 20: sys.exit(f'REFUSE: only {len(elig)} eligible parts (need 20)')
key = lambda h: hashlib.sha256(h.encode()).hexdigest()
pick = sorted(elig, key=lambda r: key(r[0]))[:20]
fd = os.open(f'{a}/canary.manifest', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f: f.write(''.join(f'{h}\t{p}\n' for h, p in pick))
print('canary', len(pick), 'sha256', hashlib.sha256(open(f'{a}/canary.manifest', 'rb').read()).hexdigest())
PY
   }
   if ! new_manifest; then rm -rf -- "$A"; echo "REFUSE: E failed; removed the new attempt dir $A (history untouched)"; exit 1; fi
   printf '%s\n' "$A" > "$D/ATTEMPT.tmp"; mv "$D/ATTEMPT.tmp" "$D/ATTEMPT"; echo "attempt: $A" ;;
F) step "write set BEFORE + preflight, bound to this attempt's manifest"
   A=$(attempt); [[ ! -e "$A/before.json" ]] || { echo "REFUSE: before.json exists (one capture per attempt)"; exit 1; }
   bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/before.json"
   bun "$OPS/writeset.ts" preflight "$A/before.json"
   (set -o noclobber; printf '%s %s\n' "$(sha "$A/before.json")" "$(sha "$A/canary.manifest")" > "$A/preflight.ok") ;;
G) step "run: verify bindings, open admission to THIS manifest, extract (one foreground owner), close admission"
   A=$(attempt); bindings "$A"; [[ ! -e "$A/run.json" ]] || { echo "REFUSE: this attempt already ran"; exit 1; }
   no_runner
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); h=d.get("halted"); print("bridge halted:", h); sys.exit(1 if h else 0)' || { echo "REFUSE: bridge halt latch is set (or status unavailable)"; exit 1; }
   admission_is_closed || { echo "REFUSE: admission not closed before the run"; exit 1; }
   install -d -m 0700 "$A/checkout"; (set -o noclobber; date -u +%FT%TZ > "$A/T_start")
   gb config set cycle.extract_atoms.admit_hashes_file "$A/canary.manifest"
   [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$A/canary.manifest" ]] || { echo "REFUSE: admission readback mismatch"; exit 1; }
   luna_env; export GBRAIN_EXTRACT_PHASE_BUDGET_MS=3600000
   set +e; (cd "$W" && set -o noclobber && bun src/cli.ts dream --source default --dir "$A/checkout" --phase extract_atoms --json > "$A/run.json" 2> "$A/run.err"); rc=$?; set -e
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"
   admission_is_closed || { echo "ALERT: admission did not close; close it by hand before anything else"; exit 1; }
   grep -E "admission manifest|\[extract_atoms\]" "$A/run.err" | tail -20 || true
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("bridge halted after run:", d.get("halted"))' || echo "bridge status unavailable"
   echo "dream rc=$rc"; [[ $rc == 0 ]] || { echo "STOP: dream exited $rc -> run 'rollback' (it captures the post-failure write set)"; exit $rc; } ;;
H) step "write set AFTER (bound to BEFORE) + checks"
   A=$(attempt); bindings "$A"; [[ -e "$A/run.json" ]] || { echo "REFUSE: G has not run in this attempt"; exit 1; }
   bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/after.json" --like "$A/before.json"
   bun "$OPS/rollback-batch.ts" plan "$A/before.json" "$A/after.json" | (set -o noclobber; tee "$A/plan.json")
   python3 -I - "$A" <<'PY'
import json, sys
from collections import Counter
a = sys.argv[1]; before = json.load(open(f'{a}/before.json')); after = json.load(open(f'{a}/after.json'))
b = {x['id'] for x in before['atoms']}; new = [x for x in after['atoms'] if x['id'] not in b]
noprov = [x['id'] for x in new if not x['frontmatter'].get('extracted_model') or not x['frontmatter'].get('extracted_route')]
live = Counter(g['owner_key'] for g in after['generations'] if g['state'] == 'live')
print(json.dumps({'new_atoms': len(new), 'atoms_without_provenance': noprov, 'owner_keys_with_multiple_live_generations': {k: n for k, n in live.items() if n > 1},
                  'served_models': dict(Counter(x['frontmatter'].get('extracted_model') for x in new)), 'routes': dict(Counter(x['frontmatter'].get('extracted_route') for x in new))}))
PY
   python3 -I - "$(< "$A/T_start")" <<'PY'
import json, sys
from collections import Counter
rows = [json.loads(l) for l in open('/srv/chatgpt-plan-bridge/state/requests.jsonl') if l.strip()]
rows = [r for r in rows if r['ts'] >= sys.argv[1]]
print(json.dumps({'bridge_requests_since_T_start': len(rows), 'by_status_code': dict(Counter(f"{r.get('status')}:{r.get('code', r.get('finish'))}" for r in rows))}))
PY
   echo "PASS needs: 0 atoms without provenance, 0 duplicate live generations, 0 unknown_completion, 0 401/403, 0 malformed/length, latch clear." ;;
I) step "runners STAY STOPPED until acceptance (DESIGN §8); admission is CLOSED"
   A=$(attempt); admission_is_closed && echo "admission CLOSED"
   svc is-active gbrain-autopilot.service || true
   echo "next: K (blind kit of ALL this attempt's atoms), the blind rating (R1 Opus + R2 Pebble), S; then 'resume' on PASS or 'rollback' on FAIL" ;;
K) step "blind kit from THIS attempt's atom write set (plan.json new + changed atom ids); brief + calibration hash-pinned"
   A=$(attempt); bindings "$A"; [[ -s "$A/plan.json" && -s "$A/after.json" ]] || { echo "REFUSE: H has not run in this attempt"; exit 1; }
   python3 -I "$OPS/make_kit.py" "$A" ;;
S) step "score: seal both raters' labels, score each (DESIGN §8 r5); rating/PASS only if BOTH pass"
   A=$(attempt); R=$A/rating; rc=0; [[ -s $R/key.json ]] || { echo "REFUSE: no kit (run K)"; exit 1; }
   for f in labels-r1.jsonl labels-r2-pebble.jsonl; do [[ -s $R/$f ]] || { echo "REFUSE: $R/$f missing"; exit 1; }; chmod 0444 "$R/$f"; sha256sum "$R/$f"; done
   for f in labels-r1.jsonl labels-r2-pebble.jsonl; do
     echo "== $f"; set +e; python3 -I "$OPS/score.py" "$R/key.json" "$R/$f"; r=$?; set -e
     # 0 = scored PASS, 10 = scored FAIL; anything else (2 invalid labels, 3 error, 1 a crash) is never a score
     [[ $r == 0 || $r == 10 ]] || { echo "STOP: $f was not scored (exit $r): fix the labels or the kit, never the score"; exit 2; }; [[ $r == 0 ]] || rc=1
   done
   if [[ $rc == 0 ]]; then (set -o noclobber; date -u +%FT%TZ > "$R/PASS"); echo "ACCEPTANCE (rating): PASS -> resume"; else echo "ACCEPTANCE (rating): FAIL -> rollback"; fi
   exit $rc ;;
resume) step "acceptance PASSED: close the attempt, disable extraction for the UNPATCHED live autopilot, restart it"
   A=$(attempt); bindings "$A"; [[ -e "$A/after.json" ]] || { echo "REFUSE: H has not captured AFTER"; exit 1; }
   [[ -s "$A/rating/PASS" ]] || { echo "REFUSE: no rating PASS from S (a FAIL goes to rollback)"; exit 1; }
   admission_is_closed || { echo "REFUSE: admission not closed"; exit 1; }
   disable_extraction
   (set -o noclobber; echo "accepted $(date -u +%FT%TZ)" > "$A/closed")
   svc start gbrain-autopilot.service; svc is-active gbrain-autopilot.service ;;
rollback) step "FAIL or STOP: scoped rollback (§8b) of THIS attempt; DONE-verified before anything restarts"
   A=$(attempt); bindings "$A"
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"; admission_is_closed || { echo "REFUSE: cannot close admission"; exit 1; }
   no_runner
   # G can fail before H ran: capture the post-failure write set now (runners stopped, admission closed), never guess it.
   if [[ ! -e "$A/after.json" ]]; then echo "after.json missing: capturing the post-failure write set";
     bun "$OPS/writeset.ts" capture "$A/canary.manifest" "$CORPUS" "$A/after.json" --like "$A/before.json"; fi
   python3 -I - "$A" <<'PY'
import json, os, sys
a = sys.argv[1]; b = json.load(open(f'{a}/before.json')); x = json.load(open(f'{a}/after.json'))
t0 = open(f'{a}/T_start').read().strip() if os.path.exists(f'{a}/T_start') else ''
assert x['manifest_sha256'] == b['manifest_sha256'], 'after.json is bound to a different manifest'
assert x['receipt_families'] == b['receipt_families'], 'after.json uses different receipt families'
assert not t0 or x['captured_at'] >= t0, "after.json predates this attempt's run"
print('after.json bound to this attempt')
PY
   bun "$OPS/rollback-batch.ts" plan "$A/before.json" "$A/after.json"
   bun "$OPS/rollback-batch.ts" apply "$A/before.json" "$A/after.json"     # exits non-zero unless the final verify is DONE
   bun "$OPS/rollback-batch.ts" verify "$A/before.json" "$A/after.json"    # exits 0 only on DONE; set -e stops otherwise
   gb config set models.dream.extract_atoms "$GEMMA"
   disable_extraction
   (set -o noclobber; echo "rolled-back $(date -u +%FT%TZ)" > "$A/closed")
   svc start gbrain-autopilot.service; svc is-active gbrain-autopilot.service ;;
*) echo "unknown step $STEP"; exit 2 ;;
esac
