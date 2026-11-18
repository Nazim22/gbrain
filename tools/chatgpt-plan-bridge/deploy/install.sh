#!/bin/bash
# Install chatgpt-plan-bridge from a reviewed git head. Runs ONLY under the owner's terminal GO (DESIGN.md §8).
# Usage: install.sh <bridge-worktree> <expected-head-sha> [plan|paid]      (default: plan, unchanged)
# paid (GBRAIN-S593, PAID-RUNBOOK.md): OpenAI API-key mode with the daily dollar ceiling. It STOPS the bridge first, writes
# everything while stopped, verifies, and RETURNS STOPPED: it never starts the service and never makes a call. The sign-in
# is not moved or touched. Starting is a separate, later step of the runbook.
# Steps: user + dirs; bundle -> /opt/chatgpt-plan-bridge/<sha>; pinned detectors; config + caller secret;
# MOVE (not copy) the gbrain-local sign-in from the eval user (single owner of the single-use refresh grant);
# systemd unit; start; health. Prints every step; stops on the first failure.
# S603: install.sh --rollback-to <sha>  = deliberate rollback to the bundle pinned in rollback.manifest (no build, no
# HEAD checks); it leaves the bridge STOPPED. start_live.sh starts either direction and binds the running process.
set -euo pipefail
OPTROOT=/opt/chatgpt-plan-bridge; E=/etc/chatgpt-plan-bridge
source "$(cd "$(dirname "$0")" && pwd)/canary_lib.sh"
if [[ ${1:-} == --rollback-to ]]; then
  R=${2:?usage: install.sh --rollback-to <sha>}; step() { echo "== $(date -u +%FT%TZ) $*"; }
  [[ $R =~ ^[0-9a-f]{40}$ && -d $OPTROOT/$R && ! -L $OPTROOT/$R ]] || { echo "REFUSE: no bundle $OPTROOT/$R"; exit 1; }
  [[ $(sed -n 's/^# sha //p' $E/rollback.manifest) == "$R" ]] || { echo "REFUSE: $R is not the pinned rollback target in $E/rollback.manifest"; exit 1; }
  grep -v '^#' $E/rollback.manifest > /tmp/s603-rb.$$; manifest_ok $OPTROOT/$R /tmp/s603-rb.$$ || { rm -f /tmp/s603-rb.$$; exit 1; }; rm -f /tmp/s603-rb.$$
  [[ $(sha256sum < $E/rollback.config.json | cut -c1-64) == "$(sed -n 's/^# config //p' $E/rollback.manifest)" ]] || { echo "REFUSE: rollback.config.json differs from its pinned hash"; exit 1; }
  step "ROLLBACK (deliberate) to $R: stop, prove no bridge process, restore its config, swap"
  systemctl disable --now chatgpt-plan-bridge.service
  [[ $(systemctl is-active chatgpt-plan-bridge.service || true) == inactive ]] || { echo "REFUSE: bridge unit is not inactive"; exit 1; }
  no_bridge_process || { echo "REFUSE: a cpbridge process is still running, or the process list could not be read"; exit 1; }
  install -m 0640 -o root -g cpbridge $E/rollback.config.json $E/config.json
  sha256sum < $E/config.json | cut -c1-64 > $E/config.pinned.sha256; date +%s > $E/swap.epoch; echo rollback > $E/swap.mode
  atomic_current $OPTROOT $R
  step "rolled back to $R; bridge STOPPED. Next: start_live.sh $R"
  exit 0
fi
W=$1 WANT=$2 MODE=${3:-plan}
[[ $MODE == plan || $MODE == paid ]] || { echo "mode must be plan or paid"; exit 1; }
HEAD=$(git -C "$W" rev-parse HEAD); [[ $HEAD == "$WANT" ]] || { echo "HEAD $HEAD != expected $WANT"; exit 1; }
[[ -z $(git -C "$W" status --porcelain) ]] || { echo "worktree not clean"; exit 1; }
SRC=$W/tools/chatgpt-plan-bridge; OPT=/opt/chatgpt-plan-bridge/$HEAD; PORT=18795
step() { echo "== $(date -u +%FT%TZ) $*"; }
# S603 guards: a known deployed identity, the candidate must contain it, and an existing bundle is never rebuilt.
if [[ -e $OPTROOT/current || -L $OPTROOT/current ]]; then
  DEPLOYED=$(deployed_sha $OPTROOT) || exit 1
  require_descendant "$W" "$DEPLOYED" "$HEAD" || exit 1
  echo "deployed $DEPLOYED is an ancestor of $HEAD"
else
  DEPLOYED=""; echo "first install: no current bundle"
fi
[[ ! -e $OPT ]] || { echo "REFUSE: $OPT already exists; a bundle is never rebuilt in place"; exit 1; }

if [[ $MODE == paid ]]; then
  step "paid: stop the bridge and prove nothing of it runs (no writer may touch the state during migration)"
  id cpbridge >/dev/null
  [[ ! -e /srv/chatgpt-plan-bridge/state/halted.json && ! -L /srv/chatgpt-plan-bridge/state/halted.json ]] || { echo "REFUSE: a halt latch is present; its reason needs its own recorded disposition first (never cleared here)"; exit 1; }
  systemctl disable --now chatgpt-plan-bridge.service
  [[ $(systemctl is-active chatgpt-plan-bridge.service || true) == inactive ]] || { echo "REFUSE: bridge unit is not inactive"; exit 1; }
  no_bridge_process || { echo "REFUSE: a cpbridge process is still running, or the process list could not be read"; exit 1; }
  # Preimages for rollback: the plan config as installed and the bundle 'current' pointed at. Taken once, never replaced.
  if grep -q '"api_key"' $E/config.json; then
    [[ -s $E/config.json.pre-paid && -s $E/current.pre-paid ]] || { echo "REFUSE: config is already paid but the rollback preimages are missing"; exit 1; }
  elif [[ -e $E/config.json.pre-paid ]]; then
    cmp -s $E/config.json.pre-paid $E/config.json || { echo "REFUSE: a pre-paid config preimage exists and differs from the installed plan config"; exit 1; }
  else
    # First paid install on this host. The stopped state is recorded BEFORE anything changes: it is what rollback
    # restores and what proves this is the first paid initialisation of the counters.
    [[ -s $E/verify-baseline.pre-paid ]] || { echo "REFUSE: runbook step 0 was not run (no $E/verify-baseline.pre-paid)"; exit 1; }
    baseline_stage_ok $E/verify-baseline.pre-paid || { echo "REFUSE: the step-0 verifier baseline did not reach the expected stage; it cannot serve as the rollback reference"; exit 1; }
    [[ -f /srv/chatgpt-plan-bridge/state/requests.jsonl && ! -L /srv/chatgpt-plan-bridge/state/requests.jsonl ]] || { echo "REFUSE: the request ledger is missing; first-paid initialisation cannot be shown"; exit 1; }
    install -d -m 0750 -o root -g cpbridge $E/units.pre-paid
    for u in chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.service chatgpt-plan-bridge-egress.timer; do install -m 0644 /etc/systemd/system/$u $E/units.pre-paid/$u; done
    python3 -I - > $E/pre-paid-baseline.json <<'PY'
import hashlib, json, os, time
S = '/srv/chatgpt-plan-bridge/state'; E = '/etc/chatgpt-plan-bridge'
sha = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
led = open(f'{S}/requests.jsonl', 'rb').read()
if b'"reserved_micro"' in led: raise SystemExit('REFUSE: the ledger already holds paid rows; this is not a first paid install')
print(json.dumps({'taken_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'counters_sha256': sha(f'{S}/counters.json'),
    'ledger_lines': led.count(b'\n'), 'ledger_sha256': hashlib.sha256(led).hexdigest(), 'config_sha256': sha(f'{E}/config.json'),
    'current': os.readlink('/opt/chatgpt-plan-bridge/current'),
    'units_sha256': {u: sha(f'/etc/systemd/system/{u}') for u in ('chatgpt-plan-bridge.service', 'chatgpt-plan-bridge-egress.service', 'chatgpt-plan-bridge-egress.timer')}}))
PY
    chown root:cpbridge $E/pre-paid-baseline.json; chmod 0640 $E/pre-paid-baseline.json
    install -m 0640 -o root -g cpbridge $E/config.json $E/config.json.pre-paid; readlink /opt/chatgpt-plan-bridge/current > $E/current.pre-paid
  fi
  [[ -s $E/pre-paid-baseline.json && -d $E/units.pre-paid ]] || { echo "REFUSE: the pre-paid baseline is incomplete"; exit 1; }
  echo "preimage: $(sha256sum /etc/chatgpt-plan-bridge/config.json.pre-paid | cut -c1-16) current was $(< /etc/chatgpt-plan-bridge/current.pre-paid)"
fi

step "user + dirs"
id cpbridge >/dev/null 2>&1 || useradd --system --home-dir /srv/chatgpt-plan-bridge --shell /usr/sbin/nologin cpbridge
# Root acts on paths a less-privileged user may own: refuse any symlink in them before touching anything.
for p in /srv/chatgpt-plan-bridge /srv/chatgpt-plan-bridge/auth /srv/chatgpt-plan-bridge/state /srv/chatgpt-plan-bridge/tmp /srv/gbrain-eval /srv/gbrain-eval/auth /etc/chatgpt-plan-bridge /opt/chatgpt-plan-bridge; do
  [[ ! -L $p ]] || { echo "refusing: $p is a symlink"; exit 1; }
done
install -d -m 0755 -o root -g root /opt/chatgpt-plan-bridge /etc/chatgpt-plan-bridge
# The bridge home is ROOT-owned: the bridge user owns only the leaf dirs, so it can never swap a path component that
# root later acts on (no check-then-use race on re-install).
install -d -m 0755 -o root -g root /srv/chatgpt-plan-bridge
install -d -m 0700 -o cpbridge -g cpbridge /srv/chatgpt-plan-bridge/auth /srv/chatgpt-plan-bridge/state /srv/chatgpt-plan-bridge/tmp

step "bundle + detectors into a fresh stage (root-owned, read-only to the bridge)"
STAGE=$OPTROOT/.stage-$HEAD-$$; [[ ! -e $STAGE ]] || { echo "REFUSE: $STAGE exists"; exit 1; }
install -d -m 0755 -o root -g root "$STAGE" "$STAGE/detectors"
(cd "$W" && /root/.bun/bin/bun build tools/chatgpt-plan-bridge/main.ts --target=bun --outfile "$STAGE/bridge.js")
install -m 0644 "$SRC/detector_check.py" "$STAGE/detectors/detector_check.py"
install -m 0644 /root/work/dream-s552-vault-atoms/pilot/detector/ingest-session-transcript.py "$STAGE/detectors/redactor.py"
echo "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d  $STAGE/detectors/redactor.py" | sha256sum -c -
install -m 0755 "$SRC/deploy/egress.sh" "$STAGE/egress.sh"
install -m 0644 "$SRC/deploy/init_spend.py" "$STAGE/init_spend.py"
install -m 0755 "$(readlink -f /root/.bun/bin/bun)" "$STAGE/bun"   # pinned runtime the bridge user can read
manifest_of "$STAGE" > "$STAGE/MANIFEST.sha256"; chmod 0644 "$STAGE/MANIFEST.sha256"
step "S603 artifact check: the candidate bundle's own handler and detectors (refuses on any failure)"
python3 -I - "$MODE" "$STAGE" "$STAGE/artifact-config.json" <<'PY'
import json, sys
mode, b, out = sys.argv[1:]
r = {"model": "gpt-6-luna", "effort": "medium", "max_output_chars": 64000}
if mode == 'paid': r.update({"max_input_tokens": 1050000, "max_output_tokens": 16000, "price_micro_per_mtok": {"input": 250000, "output": 750000}})
c = {"port": 0, "state_dir": "", "auth_dir": "", "routes": {"gpt-6-luna@medium": r},
     "ceilings": {"per_hour": 600, "per_day": 6000, "concurrency": 2, **({"usd_micro_per_day": 10000000} if mode == 'paid' else {})},
     "max_body_bytes": 262144, "upstream": {"connect_ms": 10000, "request_ms": 300000, **({"auth": "api_key"} if mode == 'paid' else {})},
     "halt_on": ["leak_gate_unavailable", "auth_unavailable", "upstream_auth", "runaway_guard"],
     "leak": {"python": "/usr/bin/python3", "detector_check": f"{b}/detectors/detector_check.py", "redactor": f"{b}/detectors/redactor.py",
              "redactor_sha256": "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d", "gitleaks": "/usr/local/bin/gitleaks", "tmp_dir": "", "timeout_ms": 20000}}
json.dump(c, open(out, 'w'))
PY
"$STAGE/bun" "$SRC/deploy/artifact_check.ts" "$STAGE/bridge.js" "$STAGE/artifact-config.json" || { echo "REFUSE: the candidate bundle failed the artifact check"; rm -rf "$STAGE"; exit 1; }
rm -f "$STAGE/artifact-config.json"
mv -T "$STAGE" "$OPT"
cat "$OPT/MANIFEST.sha256"
if [[ -n $DEPLOYED ]]; then
  step "pin the rollback target $DEPLOYED (its files and the config it runs with), before anything is swapped"
  { echo "# sha $DEPLOYED"; echo "# config $(sha256sum < $E/config.json | cut -c1-64)"; manifest_of $OPTROOT/$DEPLOYED; } > $E/rollback.manifest
  install -m 0640 -o root -g cpbridge $E/config.json $E/rollback.config.json; chmod 0644 $E/rollback.manifest
fi

step "config + caller secret"
[[ -s /etc/chatgpt-plan-bridge/caller.secret ]] || (umask 027; openssl rand -hex 32 > /etc/chatgpt-plan-bridge/caller.secret)
chown root:cpbridge /etc/chatgpt-plan-bridge/caller.secret; chmod 0640 /etc/chatgpt-plan-bridge/caller.secret
if [[ $MODE == paid ]]; then
KEY=/etc/chatgpt-plan-bridge/openai-api.key
# The key goes vault -> root-only temp file -> final owner/mode -> rename. Never an argument, never printed, no hash shown.
umask 077; tmpkey=$(mktemp /etc/chatgpt-plan-bridge/.key.XXXXXX); trap 'rm -f "$tmpkey"' EXIT
secret get openai-api-key > "$tmpkey" || { echo "REFUSE: the vault did not return the API key"; exit 1; }
[[ -s $tmpkey ]] || { echo "REFUSE: empty API key from the vault"; exit 1; }
chown root:cpbridge "$tmpkey"; chmod 0640 "$tmpkey"
if [[ -e $KEY || -L $KEY ]]; then
  [[ ! -L $KEY ]] && cmp -s "$tmpkey" "$KEY" || { echo "REFUSE: a different key file is already installed; it is not overwritten"; exit 1; }
  echo "key file already installed and identical"
else
  sync "$tmpkey"; mv -n "$tmpkey" "$KEY"; sync /etc/chatgpt-plan-bridge; echo "key file installed (root:cpbridge 0640)"
fi
rm -f "$tmpkey"; trap - EXIT; umask 022
cat > /etc/chatgpt-plan-bridge/config.json <<EOF_PAID
{ "port": $PORT, "caller_secret_file": "/etc/chatgpt-plan-bridge/caller.secret",
  "state_dir": "/srv/chatgpt-plan-bridge/state", "auth_dir": "/srv/chatgpt-plan-bridge/auth",
  "routes": { "gpt-6-luna@medium": { "model": "gpt-6-luna", "effort": "medium", "max_output_chars": 64000,
              "max_input_tokens": 1050000, "max_output_tokens": 16000, "price_micro_per_mtok": { "input": 250000, "output": 750000 } } },
  "ceilings": { "per_hour": 600, "per_day": 6000, "concurrency": 2, "usd_micro_per_day": 10000000 }, "max_body_bytes": 262144,
  "upstream": { "connect_ms": 10000, "request_ms": 300000, "auth": "api_key", "api_key_file": "/etc/chatgpt-plan-bridge/openai-api.key" },
  "halt_on": ["leak_gate_unavailable", "auth_unavailable", "upstream_auth", "runaway_guard"],
  "leak": { "python": "/usr/bin/python3", "detector_check": "$OPT/detectors/detector_check.py", "redactor": "$OPT/detectors/redactor.py",
            "redactor_sha256": "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d", "gitleaks": "/usr/local/bin/gitleaks",
            "tmp_dir": "/srv/chatgpt-plan-bridge/tmp", "timeout_ms": 20000 } }
EOF_PAID
else
cat > /etc/chatgpt-plan-bridge/config.json <<EOF
{ "port": $PORT, "caller_secret_file": "/etc/chatgpt-plan-bridge/caller.secret",
  "state_dir": "/srv/chatgpt-plan-bridge/state", "auth_dir": "/srv/chatgpt-plan-bridge/auth",
  "routes": { "gpt-6-luna@medium": { "model": "gpt-6-luna", "effort": "medium", "max_output_chars": 64000 } },
  "ceilings": { "per_hour": 600, "per_day": 6000, "concurrency": 2 }, "max_body_bytes": 262144,
  "upstream": { "connect_ms": 10000, "request_ms": 300000 },
  "halt_on": ["leak_gate_unavailable", "auth_unavailable", "upstream_auth", "runaway_guard"],
  "leak": { "python": "/usr/bin/python3", "detector_check": "$OPT/detectors/detector_check.py", "redactor": "$OPT/detectors/redactor.py",
            "redactor_sha256": "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d", "gitleaks": "/usr/local/bin/gitleaks",
            "tmp_dir": "/srv/chatgpt-plan-bridge/tmp", "timeout_ms": 20000 } }
EOF
fi
chown root:cpbridge /etc/chatgpt-plan-bridge/config.json; chmod 0640 /etc/chatgpt-plan-bridge/config.json
sha256sum < $E/config.json | cut -c1-64 > $E/config.pinned.sha256; date +%s > $E/swap.epoch; echo forward > $E/swap.mode
atomic_current $OPTROOT $HEAD

if [[ $MODE == paid ]]; then
  step "paid: first-paid spend initialisation (fail closed; existing counters preserved)"
  runuser -u cpbridge -- python3 -I "$OPT/init_spend.py" /srv/chatgpt-plan-bridge/state/counters.json /srv/chatgpt-plan-bridge/state/requests.jsonl /etc/chatgpt-plan-bridge/pre-paid-baseline.json
  step "paid: units installed, NOT started"
  install -m 0644 "$SRC/deploy/chatgpt-plan-bridge.service" /etc/systemd/system/chatgpt-plan-bridge.service
  install -m 0644 "$SRC/deploy/chatgpt-plan-bridge-egress.service" /etc/systemd/system/chatgpt-plan-bridge-egress.service
  install -m 0644 "$SRC/deploy/chatgpt-plan-bridge-egress.timer" /etc/systemd/system/chatgpt-plan-bridge-egress.timer
  systemctl daemon-reload
  python3 -I "$SRC/deploy/verify_install.py" "$W" paid
  [[ $(systemctl is-active chatgpt-plan-bridge.service || true) == inactive ]] || { echo "REFUSE: bridge unit is not inactive after install"; exit 1; }
  step "installed $HEAD in paid mode; the bridge is STOPPED and disabled. Next: paid-canary.sh (PAID-RUNBOOK.md step 3)"
  exit 0
fi

step "move the gbrain-local sign-in to the bridge user (single owner; reconciles any partial earlier move)"
# move_signin.py holds the eval user's refresh.lock for the whole move, opens everything O_NOFOLLOW, writes
# host.json then credentials.json (the commit marker) atomically, and reconciles partial states (tested: move_signin.test.sh).
python3 -I "$SRC/deploy/move_signin.py" /srv/gbrain-eval/auth /srv/chatgpt-plan-bridge/auth gbrain-eval cpbridge
ls -la /srv/chatgpt-plan-bridge/auth

step "unit + start + health"
install -m 0644 "$SRC/deploy/chatgpt-plan-bridge.service" /etc/systemd/system/chatgpt-plan-bridge.service
install -m 0644 "$SRC/deploy/chatgpt-plan-bridge-egress.service" /etc/systemd/system/chatgpt-plan-bridge-egress.service
install -m 0644 "$SRC/deploy/chatgpt-plan-bridge-egress.timer" /etc/systemd/system/chatgpt-plan-bridge-egress.timer
systemctl daemon-reload
systemctl enable --now chatgpt-plan-bridge.service
systemctl enable --now chatgpt-plan-bridge-egress.timer
sleep 2
systemctl is-active chatgpt-plan-bridge.service
nft list chain inet filter cpbridge_egress | head -14; nft list set inet filter cpbridge_egress_v4 | head -8
# Health assertions are ENFORCED: 401 without the caller secret, 200 with it (secret via curl -K on stdin, never argv).
code=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/v1/bridge/status)
[[ $code == 401 ]] || { echo "health FAIL: unauthenticated status=$code (want 401)"; exit 1; }; echo "no-secret status=401 OK"
# Body stays in memory: root never writes a file in a dir the (now running) bridge user owns — it could swap in a symlink.
resp=$(printf 'header = "Authorization: Bearer %s"\n' "$(< /etc/chatgpt-plan-bridge/caller.secret)" | curl -sS -K - -w '\n%{http_code}' http://127.0.0.1:$PORT/v1/bridge/status)
code=${resp##*$'\n'} body=${resp%$'\n'*}
[[ $code == 200 ]] || { echo "health FAIL: authenticated status=$code (want 200)"; exit 1; }; echo "with-secret status=200 OK"; echo "$body"
printf '%s' "$body" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); assert d.get("halted") is None, "bridge latch set at install"; print("routes", d["routes"])'
step "installed $HEAD"
