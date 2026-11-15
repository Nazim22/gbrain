#!/bin/bash
# Install chatgpt-plan-bridge from a reviewed git head. Runs ONLY under the owner's terminal GO (DESIGN.md §8).
# Usage: install.sh <bridge-worktree> <expected-head-sha> [plan|paid]      (default: plan, unchanged)
# paid (GBRAIN-S593, PAID-RUNBOOK.md): OpenAI API-key mode with the daily dollar ceiling. It STOPS the bridge first, writes
# everything while stopped, verifies, and RETURNS STOPPED: it never starts the service and never makes a call. The sign-in
# is not moved or touched. Starting is a separate, later step of the runbook.
# Steps: user + dirs; bundle -> /opt/chatgpt-plan-bridge/<sha>; pinned detectors; config + caller secret;
# MOVE (not copy) the gbrain-local sign-in from the eval user (single owner of the single-use refresh grant);
# systemd unit; start; health. Prints every step; stops on the first failure.
set -euo pipefail
W=$1 WANT=$2 MODE=${3:-plan}
[[ $MODE == plan || $MODE == paid ]] || { echo "mode must be plan or paid"; exit 1; }
HEAD=$(git -C "$W" rev-parse HEAD); [[ $HEAD == "$WANT" ]] || { echo "HEAD $HEAD != expected $WANT"; exit 1; }
[[ -z $(git -C "$W" status --porcelain) ]] || { echo "worktree not clean"; exit 1; }
SRC=$W/tools/chatgpt-plan-bridge; OPT=/opt/chatgpt-plan-bridge/$HEAD; PORT=18795
step() { echo "== $(date -u +%FT%TZ) $*"; }

if [[ $MODE == paid ]]; then
  step "paid: stop the bridge and prove nothing of it runs (no writer may touch the state during migration)"
  id cpbridge >/dev/null
  [[ ! -e /srv/chatgpt-plan-bridge/state/halted.json && ! -L /srv/chatgpt-plan-bridge/state/halted.json ]] || { echo "REFUSE: a halt latch is present; its reason needs its own recorded disposition first (never cleared here)"; exit 1; }
  systemctl disable --now chatgpt-plan-bridge.service
  [[ $(systemctl is-active chatgpt-plan-bridge.service || true) == inactive ]] || { echo "REFUSE: bridge unit is not inactive"; exit 1; }
  source "$SRC/deploy/canary_lib.sh"
  no_bridge_process || { echo "REFUSE: a cpbridge process is still running, or the process list could not be read"; exit 1; }
  # Preimages for rollback: the plan config as installed and the bundle 'current' pointed at. Taken once, never replaced.
  E=/etc/chatgpt-plan-bridge
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
install -d -m 0755 -o root -g root /opt/chatgpt-plan-bridge "$OPT" "$OPT/detectors" /etc/chatgpt-plan-bridge
# The bridge home is ROOT-owned: the bridge user owns only the leaf dirs, so it can never swap a path component that
# root later acts on (no check-then-use race on re-install).
install -d -m 0755 -o root -g root /srv/chatgpt-plan-bridge
install -d -m 0700 -o cpbridge -g cpbridge /srv/chatgpt-plan-bridge/auth /srv/chatgpt-plan-bridge/state /srv/chatgpt-plan-bridge/tmp

step "bundle + detectors (root-owned, read-only to the bridge)"
(cd "$W" && /root/.bun/bin/bun build tools/chatgpt-plan-bridge/main.ts --target=bun --outfile "$OPT/bridge.js")
install -m 0644 "$SRC/detector_check.py" "$OPT/detectors/detector_check.py"
install -m 0644 /root/work/dream-s552-vault-atoms/pilot/detector/ingest-session-transcript.py "$OPT/detectors/redactor.py"
echo "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d  $OPT/detectors/redactor.py" | sha256sum -c -
install -m 0755 "$SRC/deploy/egress.sh" "$OPT/egress.sh"
install -m 0644 "$SRC/deploy/init_spend.py" "$OPT/init_spend.py"
install -m 0755 "$(readlink -f /root/.bun/bin/bun)" "$OPT/bun"   # pinned runtime the bridge user can read
ln -sfn "$OPT" /opt/chatgpt-plan-bridge/current
sha256sum "$OPT/bridge.js" "$OPT/detectors/"* "$OPT/egress.sh" "$OPT/bun"

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
  "leak": { "python": "/usr/bin/python3", "detector_check": "$OPT/detectors/detector_check.py", "redactor": "$OPT/detectors/redactor.py",
            "redactor_sha256": "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d", "gitleaks": "/usr/local/bin/gitleaks",
            "tmp_dir": "/srv/chatgpt-plan-bridge/tmp", "timeout_ms": 20000 } }
EOF
fi
chown root:cpbridge /etc/chatgpt-plan-bridge/config.json; chmod 0640 /etc/chatgpt-plan-bridge/config.json

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
