#!/bin/bash
# Install chatgpt-plan-bridge from a reviewed git head. Runs ONLY under the owner's terminal GO (DESIGN.md §8).
# Usage: install.sh <bridge-worktree> <expected-head-sha>
# Steps: user + dirs; bundle -> /opt/chatgpt-plan-bridge/<sha>; pinned detectors; config + caller secret;
# MOVE (not copy) the gbrain-local sign-in from the eval user (single owner of the single-use refresh grant);
# systemd unit; start; health. Prints every step; stops on the first failure.
set -euo pipefail
W=$1 WANT=$2
HEAD=$(git -C "$W" rev-parse HEAD); [[ $HEAD == "$WANT" ]] || { echo "HEAD $HEAD != expected $WANT"; exit 1; }
[[ -z $(git -C "$W" status --porcelain) ]] || { echo "worktree not clean"; exit 1; }
SRC=$W/tools/chatgpt-plan-bridge; OPT=/opt/chatgpt-plan-bridge/$HEAD; PORT=18795
step() { echo "== $(date -u +%FT%TZ) $*"; }

step "user + dirs"
id cpbridge >/dev/null 2>&1 || useradd --system --home-dir /srv/chatgpt-plan-bridge --shell /usr/sbin/nologin cpbridge
install -d -m 0755 -o root -g root /opt/chatgpt-plan-bridge "$OPT" "$OPT/detectors" /etc/chatgpt-plan-bridge
install -d -m 0700 -o cpbridge -g cpbridge /srv/chatgpt-plan-bridge /srv/chatgpt-plan-bridge/auth /srv/chatgpt-plan-bridge/state /srv/chatgpt-plan-bridge/tmp

step "bundle + detectors (root-owned, read-only to the bridge)"
(cd "$W" && /root/.bun/bin/bun build tools/chatgpt-plan-bridge/main.ts --target=bun --outfile "$OPT/bridge.js")
install -m 0644 "$SRC/detector_check.py" "$OPT/detectors/detector_check.py"
install -m 0644 /root/work/dream-s552-vault-atoms/pilot/detector/ingest-session-transcript.py "$OPT/detectors/redactor.py"
echo "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d  $OPT/detectors/redactor.py" | sha256sum -c -
install -m 0755 "$SRC/deploy/egress.sh" "$OPT/egress.sh"
install -m 0755 "$(readlink -f /root/.bun/bin/bun)" "$OPT/bun"   # pinned runtime the bridge user can read
ln -sfn "$OPT" /opt/chatgpt-plan-bridge/current
sha256sum "$OPT/bridge.js" "$OPT/detectors/"* "$OPT/egress.sh" "$OPT/bun"

step "config + caller secret"
[[ -s /etc/chatgpt-plan-bridge/caller.secret ]] || (umask 027; openssl rand -hex 32 > /etc/chatgpt-plan-bridge/caller.secret)
chown root:cpbridge /etc/chatgpt-plan-bridge/caller.secret; chmod 0640 /etc/chatgpt-plan-bridge/caller.secret
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
chown root:cpbridge /etc/chatgpt-plan-bridge/config.json; chmod 0640 /etc/chatgpt-plan-bridge/config.json

step "move the gbrain-local sign-in to the bridge user (single owner)"
if [[ ! -s /srv/chatgpt-plan-bridge/auth/credentials.json ]]; then
  [[ ! -e /srv/gbrain-eval/auth/refresh.pending ]] || { echo "eval refresh.pending present: refuse"; exit 1; }
  for f in credentials.json host.json; do install -m 0600 -o cpbridge -g cpbridge "/srv/gbrain-eval/auth/$f" "/srv/chatgpt-plan-bridge/auth/$f"; done
  cmp /srv/gbrain-eval/auth/credentials.json /srv/chatgpt-plan-bridge/auth/credentials.json
  shred -u /srv/gbrain-eval/auth/credentials.json
fi
ls -la /srv/chatgpt-plan-bridge/auth

step "unit + start + health"
install -m 0644 "$SRC/deploy/chatgpt-plan-bridge.service" /etc/systemd/system/chatgpt-plan-bridge.service
systemctl daemon-reload
systemctl enable --now chatgpt-plan-bridge.service
sleep 2
systemctl is-active chatgpt-plan-bridge.service
nft list chain inet filter cpbridge_egress | head -12
curl -sS -o /dev/null -w 'no-secret status=%{http_code}\n' http://127.0.0.1:$PORT/v1/bridge/status
curl -sS -H "Authorization: Bearer $(cat /etc/chatgpt-plan-bridge/caller.secret)" http://127.0.0.1:$PORT/v1/bridge/status; echo
step "installed $HEAD"
