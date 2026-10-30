#!/bin/bash
# Luna canary, stage 1 (CANARY-PACKET.md; DESIGN.md r4 fae517a8). ONE step per invocation, output in full:
#   canary.sh <A|V|B|C|D|E|F|G|R|H|I|K|S|resume|rollback> <reviewed-head-full-sha>   (R: stage 2 only)
# A installs the bridge; V instead binds an ALREADY-installed bridge to these reviewed bytes. K builds the blind kit from the
# attempt's atom write set; S scores both raters' sealed labels and writes rating/PASS only if both pass (resume requires it).
# Every step refuses unless the worktree is clean at exactly <reviewed-head>; that worktree's src/ IS the gbrain runtime
# for D–H (bun $W/src/cli.ts) and its tools/ is the bridge installed in A. Live autopilot stays stopped from C until
# 'resume' (acceptance PASS) or a DONE-verified 'rollback'.
# Attempts: E creates a fresh no-clobber attempt dir (and refuses while a previous attempt is open); F–I, resume and
# rollback act only on that attempt, and verify the chain manifest -> before.json -> preflight.ok -> run -> after.json.
set -euo pipefail
STEP=${1:?step} WANT=${2:?reviewed head}
W=/root/work/gbrain-luna484 OPS=$W/tools/chatgpt-plan-bridge/ops D=/root/work/dream-s552-luna/canary DB=gbrain_pingu
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
SECRET=/etc/chatgpt-plan-bridge/caller.secret LEDGER=/srv/chatgpt-plan-bridge/state/requests.jsonl
if [[ ${CANARY_DRYRUN:-} == 1 ]]; then   # stage-2 rehearsal only: a local stub bridge and a scratch corpus copy
  if [[ -n ${CANARY_PORT:-} ]]; then PORT=$CANARY_PORT; fi
  if [[ -n ${CANARY_SECRET:-} ]]; then SECRET=$CANARY_SECRET; fi
  if [[ -n ${CANARY_LEDGER:-} ]]; then LEDGER=$CANARY_LEDGER; fi
  if [[ -n ${CANARY_CORPUS:-} ]]; then CORPUS=$CANARY_CORPUS; fi
fi
# Stage 2 (STAGE2-DESIGN r3, Pebble whole-object HOLD 19:10Z): CANARY_STAGE2=1 binds the runbook's checks into the steps:
# D leaves the corpus key ABSENT; G holds it only from OPEN to CLOSED, checks member bytes + session growth immediately
# before OPEN, and closes everything on any failure after OPEN; S and resume require date_gates.py's bound gates.ok;
# an empty write set completes on the gates alone; resume records the batch's atoms for later batches' checks.
S2() { [[ ${CANARY_STAGE2:-} == 1 ]]; }
[[ $(git -C "$W" rev-parse HEAD) == "$WANT" && -z $(git -C "$W" status --porcelain) ]] || { echo "REFUSE: $W is not clean at $WANT"; exit 1; }
source /root/.gbrain/pg.env
# libpq reads these from the ENVIRONMENT (no password on any argv); PGDATABASE is a plain name, never a URI.
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE="$DB" PGPASSWORD="$PASS"
export DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/$DB"   # environment only, read by the bun tools
gb() { (cd "$W" && bun src/cli.ts "$@"); }
q() { psql -XAt -v ON_ERROR_STOP=1 -F ' | ' -c "$1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
step() { echo "=== $(date -u +%FT%TZ) $STEP: $*"; }
luna_env() { export LITELLM_BASE_URL="http://127.0.0.1:$PORT/v1"; export LITELLM_API_KEY="$(< "$SECRET")"; }
bridge_status() { printf 'header = "Authorization: Bearer %s"\n' "$(< "$SECRET")" | curl -sS -f -K - "http://127.0.0.1:$PORT/v1/bridge/status"; }
g_cleanup() {   # stage-2 G EXIT trap (Pebble 19:30Z #2): attempt BOTH closures independently, verify each, keep the failure status
  local rc=$? adm=UNKNOWN corp=UNKNOWN; set +e
  if [[ ${CANARY_DRYRUN:-} == 1 && ${CANARY_DRYRUN_FAULT:-} == after-open-noadmclose ]]; then echo "[dry-run] admission close skipped (simulated failure)"
  else gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest" >/dev/null 2>&1; fi
  gb config unset dream.synthesize.session_corpus_dir >/dev/null 2>&1
  [[ $(db_value cycle.extract_atoms.admit_hashes_file 2>/dev/null) == "$D/closed.manifest" ]] && adm=verified
  [[ $(db_count dream.synthesize.session_corpus_dir 2>/dev/null) == 0 && $(file_has_corpus 2>/dev/null) == 0 ]] && corp=verified
  echo "STOP: G failed after OPEN (exit $rc). admission closed: $adm; corpus key absent (db+file): $corp. Run state_check.sh post-run; any UNKNOWN -> close by hand."
  [[ $rc != 0 ]] || rc=1; exit "$rc"
}
gates_ok() {   # stage 2: date_gates.py PASS receipt bound to the CURRENT plan.json, after.json and members
  local A=$1; [[ -n ${CANARY_MEMBERS:-} && -s $CANARY_MEMBERS && -s $A/gates.ok ]] || { echo "REFUSE: no gates.ok (run date_gates.py) or CANARY_MEMBERS unset"; exit 1; }
  [[ $(< "$A/gates.ok") == "$(sha "$A/plan.json") $(sha "$A/after.json") $(sha "$CANARY_MEMBERS")" ]] || { echo "REFUSE: gates.ok does not bind this plan/after/members"; exit 1; }
}
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
   echo "last bridge ledger row (no text by design):"; tail -1 "$LEDGER" ;;
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
   if S2; then disable_extraction; else gb config set dream.synthesize.session_corpus_dir "$CORPUS"; fi   # stage 2: G holds it OPEN..CLOSED
   for k in dream.synthesize.enabled models.dream.extract_atoms cycle.extract_atoms.admit_hashes_file dream.synthesize.session_corpus_dir; do echo "$k = $(db_value $k)"; done
   gb pricing set "$ROUTE" --input 0 --output 0 --source "subscription: ChatGPT Pro via Sign in with ChatGPT (owner-verified allowance, Nazz 2026-10-26)"
   [[ -e "$D/config.json.before" ]] || cp -p "$CFG" "$D/config.json.before"
   python3 -I - "$PORT" "$CFG" <<'PY'
import json, sys, os
p = sys.argv[2]; c = json.load(open(p)); c.setdefault('provider_base_urls', {})['litellm'] = f'http://127.0.0.1:{sys.argv[1]}/v1'
tmp = p + '.tmp'; json.dump(c, open(tmp, 'w'), indent=2); os.chmod(tmp, 0o600); os.replace(tmp, p); print('provider_base_urls.litellm =', c['provider_base_urls']['litellm'])
PY
   ;;
E) step "new attempt: fresh read-only inventory; manifest = 20 MISSING never exposed by an earlier attempt, lowest sha256(hash16) (stage 2: the CANARY_MANIFEST slice, all or nothing)"
   if [[ -s "$D/ATTEMPT" ]]; then prev=$(< "$D/ATTEMPT"); [[ -e "$prev/closed" ]] || { echo "REFUSE: previous attempt $prev is still open (resume or rollback it)"; exit 1; }; fi
   A="$D/attempt-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -m 0700 "$A"            # fails if it exists: no clobber
   # set -e does not apply inside an if-tested function: every step returns explicitly. On failure the new (empty of any
   # manifest) attempt dir is removed so it can never read as malformed history; earlier attempts are never touched.
   if S2; then [[ -n ${CANARY_MANIFEST:-} && -n ${CANARY_RENAMES:-} ]] || { rmdir "$A"; echo "REFUSE: stage 2 needs CANARY_MANIFEST and CANARY_RENAMES"; exit 1; }; fi
   new_manifest() {
     bun "$OPS/inventory.ts" "$CORPUS" "$A/inventory" ${CANARY_RENAMES:+"$CANARY_RENAMES"} > "$A/inventory.out" || return 1   # both aliases (stage 2)
     python3 -I -c "import json;d=json.load(open('$A/inventory.out'));print(d['discovered'],d['counts'])" || return 1
     python3 -I - "$A" "${CANARY_MANIFEST:-}" "${CANARY_RENAMES:-}" <<'PY' || return 1
import glob, hashlib, os, re, sys
a, supplied, renames = sys.argv[1], sys.argv[2], sys.argv[3]
rows = [l.rstrip('\n').split('\t') for l in open(f'{a}/inventory/missing.manifest') if l.strip()]
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
# Stage 2: a renamed part has two paths; exposure under either one counts (renames.tsv: legacy, dated, ...).
alias = {}
if renames:
    for l in open(renames):
        f = l.rstrip('\n').split('\t'); alias[f[0]] = f[1]; alias[f[1]] = f[0]
exposed = lambda h, p: h in seen_h or p in seen_p or alias.get(p) in seen_p
elig = [r for r in rows if not exposed(r[0], r[1])]
print(f'history: {prior} earlier attempt(s), {len(seen_h)} parts exposed; {len(rows) - len(elig)} of {len(rows)} MISSING excluded; {len(elig)} eligible')
if not supplied:
    if len(elig) < 20: sys.exit(f'REFUSE: only {len(elig)} eligible parts (need 20)')
    key = lambda h: hashlib.sha256(h.encode()).hexdigest()
    pick = sorted(elig, key=lambda r: key(r[0]))[:20]
else:   # stage 2 (STAGE2-DESIGN r3): a frozen batch slice, taken as given or refused whole
    lines = open(supplied).read().splitlines(); pick, why = [], []
    if not 1 <= len(lines) <= 100: sys.exit(f'REFUSE: supplied manifest has {len(lines)} pairs (1..100)')
    missing = {(h, p) for h, p in rows}
    for l in lines:
        f = l.split('\t')
        if len(f) != 2 or not re.fullmatch(r'[0-9a-f]{16}', f[0]) or not f[1].startswith('/'): sys.exit(f'REFUSE: malformed supplied line: {l!r}')
        pick.append((f[0], f[1]))
    if len({h for h, _ in pick}) != len(pick) or len({p for _, p in pick}) != len(pick): sys.exit('REFUSE: duplicate hash or path in the supplied manifest')
    for h, p in pick:
        try: now = hashlib.sha256(open(p, 'rb').read()).hexdigest()[:16]
        except OSError: now = 'unreadable'
        if now != h: why.append(f'bytes changed or unreadable: {p}')
        elif (h, p) not in missing: why.append(f'no longer MISSING: {p}')
        elif exposed(h, p): why.append(f'previously exposed (hash or either path): {p}')
    if why: sys.exit('REFUSE: ' + '; '.join(why[:5]) + (f' (+{len(why) - 5} more)' if len(why) > 5 else ''))
fd = os.open(f'{a}/canary.manifest', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f: f.write(''.join(f'{h}\t{p}\n' for h, p in pick))
print('canary', len(pick), 'sha256', hashlib.sha256(open(f'{a}/canary.manifest', 'rb').read()).hexdigest())
PY
   }
   if ! new_manifest; then rm -rf -- "$A"; echo "REFUSE: E failed; removed the new attempt dir $A (history untouched)"; exit 1; fi
   if S2; then printf '%s %s\n' "$(sha "$CANARY_MANIFEST")" "$(sha "$CANARY_RENAMES")" > "$A/STAGE2"; fi
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
   if S2; then   # stage 2: members bind this manifest; bytes + session growth checked immediately before OPEN
     [[ -n ${CANARY_MEMBERS:-} && -n ${CANARY_SESSIONS:-} && -e $A/STAGE2 ]] || { echo "REFUSE: stage 2 needs CANARY_MEMBERS, CANARY_SESSIONS and a stage-2 attempt"; exit 1; }
     cmp -s <(awk -F'\t' '{print $1"\t"$4}' "$CANARY_MEMBERS") "$A/canary.manifest" || { echo "REFUSE: members do not bind this canary.manifest"; exit 1; }
     corpus_present=$(db_count dream.synthesize.session_corpus_dir); [[ $corpus_present == 0 && $(file_has_corpus) == 0 ]] || { echo "REFUSE: corpus key present before OPEN"; exit 1; }
     python3 -I "$OPS/date_parts.py" bytes-check "$CANARY_MEMBERS" || { echo "REFUSE (no OPEN): a member's bytes changed since the freeze"; exit 1; }
     python3 -I "$OPS/date_parts.py" sessions-check "$CANARY_MEMBERS" "$CANARY_SESSIONS" || { echo "REFUSE (no OPEN): a member's session grew since the freeze"; exit 1; }
   fi
   install -d -m 0700 "$A/checkout"; (set -o noclobber; date -u +%FT%TZ > "$A/T_start")
   if S2; then trap g_cleanup EXIT; fi
   gb config set cycle.extract_atoms.admit_hashes_file "$A/canary.manifest"
   [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$A/canary.manifest" ]] || { echo "REFUSE: admission readback mismatch"; exit 1; }
   if S2; then gb config set dream.synthesize.session_corpus_dir "$CORPUS"; fi   # the corpus key exists only from OPEN to CLOSED
   if [[ ${CANARY_DRYRUN:-} == 1 && ${CANARY_DRYRUN_FAULT:-} == after-open* ]]; then echo "[dry-run] injected failure after OPEN"; false; fi
   luna_env; export GBRAIN_EXTRACT_PHASE_BUDGET_MS=3600000
   dream=(bun src/cli.ts dream --source default --dir "$A/checkout" --phase extract_atoms --json)
   if [[ ${CANARY_DRYRUN:-} == 1 && ${CANARY_DRYRUN_FAULT:-} == dream-exit ]]; then dream=(false); fi   # rehearsal fault injection only
   set +e; (cd "$W" && set -o noclobber && "${dream[@]}" > "$A/run.json" 2> "$A/run.err"); rc=$?; set -e
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"
   admission_is_closed || { echo "ALERT: admission did not close; close it by hand before anything else"; exit 1; }
   if S2; then disable_extraction; trap - EXIT; fi
   grep -E "admission manifest|\[extract_atoms\]" "$A/run.err" | tail -20 || true
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("bridge halted after run:", d.get("halted"))' || echo "bridge status unavailable"
   echo "dream rc=$rc"; [[ $rc == 0 ]] || { echo "STOP: dream exited $rc -> run 'rollback' (it captures the post-failure write set)"; exit $rc; } ;;
R) step "retry THIS attempt's malformed-output failures ONCE (stage 2): exclusive retry.manifest, same OPEN..CLOSE discipline as G"
   S2 || { echo "REFUSE: R is stage 2 only"; exit 1; }
   A=$(attempt); bindings "$A"
   [[ ! -e "$A/retry.manifest" ]] || { echo "REFUSE: the retry allowance of this attempt is used (retry.manifest exists)"; exit 1; }   # first: names the real cause after an interrupted R
   [[ -e "$A/run.json" && -s "$A/after.json" && -s "$A/plan.json" ]] || { echo "REFUSE: R needs G and H to have run in this attempt"; exit 1; }
   [[ -n ${CANARY_MEMBERS:-} && -n ${CANARY_SESSIONS:-} && -e $A/STAGE2 ]] || { echo "REFUSE: R needs CANARY_MEMBERS, CANARY_SESSIONS and a stage-2 attempt"; exit 1; }
   cmp -s <(awk -F'\t' '{print $1"\t"$4}' "$CANARY_MEMBERS") "$A/canary.manifest" || { echo "REFUSE: members do not bind this canary.manifest"; exit 1; }
   no_runner
   live=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()"); echo "live cycle locks: $live"; [[ $live == 0 ]] || { echo "REFUSE: live cycle locks"; exit 1; }
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); h=d.get("halted"); print("bridge halted:", h); sys.exit(1 if h else 0)' || { echo "REFUSE: bridge halt latch is set (or status unavailable)"; exit 1; }
   admission_is_closed || { echo "REFUSE: admission not closed before the retry"; exit 1; }
   [[ $(db_count dream.synthesize.session_corpus_dir) == 0 && $(file_has_corpus) == 0 ]] || { echo "REFUSE: corpus key present before OPEN"; exit 1; }
   # Eligibility (date_gates is the oracle) + exclusive retry.manifest FIRST: from here on the allowance is consumed.
   # Eligibility uses the runbook's FULL gate context: this attempt + every earlier kept batch (Pebble 22:37Z #2).
   install -d -m 0700 "$D/stage2-kept"
   python3 -I "$OPS/retry_plan.py" "$A" "$CANARY_MEMBERS" "$D/stage2-kept" || { echo "REFUSE (no OPEN): not a bounded malformed-output retry"; exit 1; }
   # Whole-attempt source stability before reopening, not just the retry members (Pebble 22:37Z): G's own checks, again.
   python3 -I "$OPS/date_parts.py" bytes-check "$CANARY_MEMBERS" || { echo "REFUSE (no OPEN): a member's bytes changed since the freeze"; exit 1; }
   python3 -I "$OPS/date_parts.py" sessions-check "$CANARY_MEMBERS" "$CANARY_SESSIONS" || { echo "REFUSE (no OPEN): a member's session grew since the freeze"; exit 1; }
   # Keep the G-pass captures byte-for-byte under their own names; H then re-captures after.json/plan.json for the whole
   # attempt (the canonical names every consumer binds, rollback included, so it covers the retry's writes too).
   for f in after plan; do mv -n "$A/$f.json" "$A/$f.g1.json"; chmod 0444 "$A/$f.g1.json"; done
   [[ ! -e "$A/after.json" && ! -e "$A/plan.json" ]] || { echo "REFUSE: could not set the G-pass captures aside"; exit 1; }
   (set -o noclobber; date -u +%FT%TZ > "$A/T_retry")
   trap g_cleanup EXIT
   gb config set cycle.extract_atoms.admit_hashes_file "$A/retry.manifest"
   [[ $(db_value cycle.extract_atoms.admit_hashes_file) == "$A/retry.manifest" ]] || { echo "REFUSE: admission readback mismatch"; exit 1; }
   gb config set dream.synthesize.session_corpus_dir "$CORPUS"   # the corpus key exists only from OPEN to CLOSED
   if [[ ${CANARY_DRYRUN:-} == 1 && ${CANARY_DRYRUN_FAULT:-} == retry-after-open ]]; then echo "[dry-run] injected failure after retry OPEN"; false; fi
   luna_env; export GBRAIN_EXTRACT_PHASE_BUDGET_MS=3600000
   rdream=(bun src/cli.ts dream --source default --dir "$A/checkout" --phase extract_atoms --json)
   if [[ ${CANARY_DRYRUN:-} == 1 && ${CANARY_DRYRUN_FAULT:-} == retry-empty-output ]]; then rdream=(true); fi   # rehearsal only: rc 0, no outcome
   set +e; (cd "$W" && set -o noclobber && "${rdream[@]}" > "$A/run-retry.json" 2> "$A/run-retry.err"); rc=$?; set -e
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"
   admission_is_closed || { echo "ALERT: admission did not close; close it by hand before anything else"; exit 1; }
   disable_extraction; trap - EXIT
   grep -E "admission manifest|\[extract_atoms\]" "$A/run-retry.err" | tail -20 || true
   echo "dream rc=$rc"; [[ $rc == 0 ]] || { echo "STOP: retry dream exited $rc (unknown outcome; no second retry)"; exit $rc; }
   # A missing, unreadable or incomplete outcome is UNKNOWN: STOP here, and date_gates refuses it too (Pebble 22:37Z #1).
   python3 -I "$OPS/retry_plan.py" --outcome "$A" || { echo "STOP: unknown retry outcome (no second retry)"; exit 1; }
   echo "next: state_check post-run, H (re-capture of the whole attempt), then date_gates" ;;
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
   python3 -I - "$(< "$A/T_start")" "$LEDGER" <<'PY'
import json, sys
from collections import Counter
rows = [json.loads(l) for l in open(sys.argv[2]) if l.strip()]
iso = lambda v: __import__('datetime').datetime.fromisoformat(v.replace('Z', '+00:00'))   # parsed: '...39.066Z' is after '...39Z'
rows = [r for r in rows if iso(r['ts']) >= iso(sys.argv[1])]
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
   if S2; then gates_ok "$A"
     if [[ $(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$R/key.json") == 0 ]]; then   # nothing to rate
       (set -o noclobber; echo "zero-atom: gates-only $(date -u +%FT%TZ)" > "$R/PASS"); echo "ACCEPTANCE: zero-atom batch, gates PASS (no labels to score) -> resume"; exit 0; fi
   fi
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
   if S2; then gates_ok "$A"; install -d -m 0700 "$D/stage2-kept"
     python3 -I - "$A" "$D/stage2-kept/$(basename "$A").json" <<'PY'
import json, sys
a, out = sys.argv[1], sys.argv[2]; ids = set(json.load(open(f'{a}/plan.json'))['new_atom_ids'])
kept = sorted(({'id': x['id'], 'content_hash': x['content_hash']} for x in json.load(open(f'{a}/after.json'))['atoms'] if x['id'] in ids), key=lambda r: r['id'])
assert len(kept) == len(ids), 'plan ids missing from after.json'
json.dump(kept, open(out, 'x')); print('kept record', out, len(kept), 'atoms')
PY
   fi
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
