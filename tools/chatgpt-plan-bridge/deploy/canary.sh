#!/bin/bash
# Luna canary, stage 1 (CANARY-PACKET.md; DESIGN.md r4 fae517a8). ONE step per invocation, output in full:
#   canary.sh <A|B|C|D|E|F|G|H|I|resume|rollback> <reviewed-head-full-sha>
# Every step refuses unless the worktree is clean at exactly <reviewed-head>; that worktree's src/ IS the gbrain runtime
# for steps D–H (bun $W/src/cli.ts), and $W/tools is the bridge source installed in A. Live autopilot stays paused from C
# until acceptance passes ('resume') or the rollback is reconciled ('rollback').
set -euo pipefail
STEP=${1:?step} WANT=${2:?reviewed head}
W=/root/work/gbrain-s552-luna-bridge OPS=$W/tools/chatgpt-plan-bridge/ops D=/root/work/dream-s552-luna/canary
CORPUS=/root/.claude/projects/-root/session-text PORT=18795 ROUTE='litellm:gpt-6-luna@medium' GEMMA='llama-server:gemma-4-12b-qat'
[[ $(git -C "$W" rev-parse HEAD) == "$WANT" && -z $(git -C "$W" status --porcelain) ]] || { echo "REFUSE: $W is not clean at $WANT"; exit 1; }
source /root/.gbrain/pg.env
# libpq reads these from the ENVIRONMENT, so no password ever reaches an argv; PGDATABASE is a plain name, never a URI.
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=gbrain PGDATABASE=gbrain_pingu PGPASSWORD="$PASS"
export DATABASE_URL="postgres://gbrain:$PASS@127.0.0.1:5432/gbrain_pingu"   # environment only, read by the bun tools
gb() { (cd "$W" && bun src/cli.ts "$@"); }
luna_env() { export LITELLM_BASE_URL="http://127.0.0.1:$PORT/v1"; export LITELLM_API_KEY="$(< /etc/chatgpt-plan-bridge/caller.secret)"; }
q() { psql -XAt -F ' | ' -c "$1"; }
bridge_status() { printf 'header = "Authorization: Bearer %s"\n' "$(< /etc/chatgpt-plan-bridge/caller.secret)" | curl -sS -K - "http://127.0.0.1:$PORT/v1/bridge/status"; }
# The live autopilot runs the UNPATCHED binary (no admission manifest): before it may run, extraction must be
# disabled the way live had it (corpus key absent), not merely "admission closed".
disable_extraction() { gb config unset dream.synthesize.session_corpus_dir || true; gb config get dream.synthesize.session_corpus_dir 2>&1 | tail -1;
  [[ -z $(q "select value from config where key='dream.synthesize.session_corpus_dir'") ]] || { echo "REFUSE: corpus key still set"; exit 1; }; }
step() { echo "=== $(date -u +%FT%TZ) $STEP: $*"; }
install -d -m 0700 "$D"; : > "$D/closed.manifest"

case "$STEP" in
A) step "install the bridge service from $WANT"
   bash "$W/tools/chatgpt-plan-bridge/deploy/install.sh" "$W" "$WANT" ;;
B) step "one real call through gbrain's gateway (synthetic prompt)"
   luna_env; bun "$OPS/real-call.ts"
   echo "last bridge ledger row (no text by design):"; tail -1 /srv/chatgpt-plan-bridge/state/requests.jsonl ;;
C) step "pause competing runners (single owner)"
   systemctl stop gbrain-autopilot.service
   systemctl is-active gbrain-autopilot.service gbrain-dream.timer || true
   [[ $(systemctl is-active gbrain-autopilot.service) != active && $(systemctl is-active gbrain-dream.timer) != active ]] || { echo "REFUSE: a runner is active"; exit 1; }
   if pgrep -af 'gbrain (autopilot|dream|cycle)'; then echo "REFUSE: a gbrain runner process exists"; exit 1; fi
   live=$(q "select count(*) from gbrain_cycle_locks where ttl_expires_at > now()"); echo "live cycle locks: $live"; [[ $live == 0 ]] || exit 1 ;;
D) step "config: synthesize off, route, admission CLOSED, then corpus key; pricing; file-plane base url"
   gb config set dream.synthesize.enabled false
   gb config set models.dream.extract_atoms "$ROUTE"
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"
   gb config set dream.synthesize.session_corpus_dir "$CORPUS"
   for k in dream.synthesize.enabled models.dream.extract_atoms cycle.extract_atoms.admit_hashes_file dream.synthesize.session_corpus_dir; do gb config get "$k"; done
   gb pricing set "$ROUTE" --input 0 --output 0 --source "subscription: ChatGPT Pro via Sign in with ChatGPT (owner-verified allowance, Nazz 2026-10-26)"
   [[ -e "$D/config.json.before" ]] || cp -p /root/.gbrain/config.json "$D/config.json.before"
   python3 -I - "$PORT" <<'PY'
import json, sys, os
p = '/root/.gbrain/config.json'; c = json.load(open(p)); c.setdefault('provider_base_urls', {})['litellm'] = f'http://127.0.0.1:{sys.argv[1]}/v1'
tmp = p + '.tmp'; json.dump(c, open(tmp, 'w'), indent=2); os.chmod(tmp, 0o600); os.replace(tmp, p); print('provider_base_urls.litellm =', c['provider_base_urls']['litellm'])
PY
   ;;
E) step "fresh read-only inventory; canary manifest = 20 MISSING with the lowest sha256(hash16); sample = 5 lowest sha256(source_hash)"
   bun "$OPS/inventory.ts" "$CORPUS" "$D/inventory" > "$D/inventory.out"; python3 -I -c "import json;d=json.load(open('$D/inventory.out'));print(d['discovered'],d['counts'])"
   python3 -I - "$D" <<'PY'
import hashlib, sys
d = sys.argv[1]; rows = [l.rstrip('\n').split('\t') for l in open(f'{d}/inventory/missing.manifest') if l.strip()]
key = lambda h: hashlib.sha256(h.encode()).hexdigest()
pick = sorted(rows, key=lambda r: key(r[0]))[:20]
open(f'{d}/canary.manifest', 'w').write(''.join(f'{h}\t{p}\n' for h, p in pick))
open(f'{d}/sample5.txt', 'w').write(''.join(f'{h}\t{p}\n' for h, p in sorted(pick, key=lambda r: key(r[0]))[:5]))
print('canary', len(pick), 'sha256', hashlib.sha256(open(f'{d}/canary.manifest','rb').read()).hexdigest())
PY
   chmod 600 "$D/canary.manifest" "$D/sample5.txt" ;;
F) step "write set BEFORE + preflight"
   bun "$OPS/writeset.ts" capture "$D/canary.manifest" "$CORPUS" "$D/before.json"
   bun "$OPS/writeset.ts" preflight "$D/before.json" ;;
G) step "run: open admission to the canary manifest, extract (one foreground owner), close admission"
   pgrep -af 'gbrain (autopilot|dream|cycle)' && { echo "REFUSE: another runner"; exit 1; } || true
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); h=d.get("halted"); print("bridge halted:", h); sys.exit(1 if h else 0)' || { echo "REFUSE: bridge halt latch is set"; exit 1; }
   install -d -m 0700 "$D/checkout"; date -u +%FT%TZ > "$D/T_start"
   gb config set cycle.extract_atoms.admit_hashes_file "$D/canary.manifest"
   luna_env; export GBRAIN_EXTRACT_PHASE_BUDGET_MS=3600000
   set +e; (cd "$W" && bun src/cli.ts dream --source default --dir "$D/checkout" --phase extract_atoms --json > "$D/run.json" 2> "$D/run.err"); rc=$?; set -e
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"
   grep -E "admission manifest|\[extract_atoms\]" "$D/run.err" | tail -20
   bridge_status | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("bridge halted after run:", d.get("halted"))'
   echo "dream rc=$rc"; [[ $rc == 0 ]] || { echo "STOP: dream exited $rc -> run 'rollback' (it captures the post-failure write set)"; exit $rc; } ;;
H) step "write set AFTER + checks"
   bun "$OPS/writeset.ts" capture "$D/canary.manifest" "$CORPUS" "$D/after.json" --like "$D/before.json"
   bun "$OPS/rollback-batch.ts" plan "$D/before.json" "$D/after.json" | tee "$D/plan.json"
   python3 -I - "$D" <<'PY'
import json, sys
d = sys.argv[1]; before = json.load(open(f'{d}/before.json')); after = json.load(open(f'{d}/after.json'))
b = {a['id'] for a in before['atoms']}; new = [a for a in after['atoms'] if a['id'] not in b]
noprov = [a['id'] for a in new if not a['frontmatter'].get('extracted_model') or not a['frontmatter'].get('extracted_route')]
from collections import Counter
live = Counter(g['owner_key'] for g in after['generations'] if g['state'] == 'live')
dup = {k: n for k, n in live.items() if n > 1}
print(json.dumps({'new_atoms': len(new), 'atoms_without_provenance': noprov, 'owner_keys_with_multiple_live_generations': dup,
                  'served_models': dict(Counter(a['frontmatter'].get('extracted_model') for a in new)), 'routes': dict(Counter(a['frontmatter'].get('extracted_route') for a in new))}))
PY
   t0=$(< "$D/T_start"); python3 -I - "$t0" <<'PY'
import json, sys
from collections import Counter
rows = [json.loads(l) for l in open('/srv/chatgpt-plan-bridge/state/requests.jsonl') if l.strip()]
rows = [r for r in rows if r['ts'] >= sys.argv[1]]
print(json.dumps({'bridge_requests_since_T_start': len(rows), 'by_status_code': dict(Counter(f"{r.get('status')}:{r.get('code', r.get('finish'))}" for r in rows))}))
PY
   echo "PASS needs: 0 atoms without provenance, 0 duplicate live generations, 0 unknown_completion, 0 401, 0 malformed/length." ;;
I) step "runners STAY PAUSED until acceptance (DESIGN §8); admission is CLOSED"
   gb config get cycle.extract_atoms.admit_hashes_file
   systemctl is-active gbrain-autopilot.service || true
   echo "next: blind rating of the 5-part sample ($D/sample5.txt); then 'resume' on PASS or 'rollback' on FAIL" ;;
resume) step "acceptance PASSED: disable extraction for the unpatched live autopilot, then restart it"
   [[ $(gb config get cycle.extract_atoms.admit_hashes_file | tail -1) == *closed.manifest* ]] || { echo "REFUSE: admission not closed"; exit 1; }
   disable_extraction
   systemctl start gbrain-autopilot.service; systemctl is-active gbrain-autopilot.service ;;
rollback) step "acceptance FAILED or STOP: scoped rollback (§8b) must verify DONE before anything restarts"
   gb config set cycle.extract_atoms.admit_hashes_file "$D/closed.manifest"
   if pgrep -af 'gbrain (autopilot|dream|cycle)'; then echo "REFUSE: a runner is active"; exit 1; fi
   [[ -s "$D/before.json" ]] || { echo "REFUSE: no before.json: nothing was admitted, nothing to roll back"; exit 1; }
   # G can fail before H ran: capture the post-failure write set now (runners paused, admission closed), never guess it.
   if [[ ! -s "$D/after.json" ]]; then echo "after.json missing: capturing the post-failure write set";
     bun "$OPS/writeset.ts" capture "$D/canary.manifest" "$CORPUS" "$D/after.json" --like "$D/before.json"; fi
   bun "$OPS/rollback-batch.ts" plan "$D/before.json" "$D/after.json"
   bun "$OPS/rollback-batch.ts" apply "$D/before.json" "$D/after.json"     # exits non-zero unless the final verify is DONE
   bun "$OPS/rollback-batch.ts" verify "$D/before.json" "$D/after.json"    # exits 0 only on DONE; set -e stops here otherwise
   gb config set models.dream.extract_atoms "$GEMMA"
   disable_extraction
   systemctl start gbrain-autopilot.service; systemctl is-active gbrain-autopilot.service ;;
*) echo "unknown step $STEP"; exit 2 ;;
esac
