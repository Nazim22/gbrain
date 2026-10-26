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
if [[ ! -e /srv/chatgpt-plan-bridge/auth/credentials.json ]]; then
  [[ ! -e /srv/gbrain-eval/auth/refresh.pending ]] || { echo "eval refresh.pending present: refuse"; exit 1; }
  # No-follow move: open each source with O_NOFOLLOW (regular file, owned by gbrain-eval, one link), create each
  # destination with O_EXCL|O_NOFOLLOW owned by cpbridge, verify bytes, then overwrite the eval copy through the
  # same no-follow handle and unlink it. `install`/`cp`/`shred` would follow a symlink the eval user planted.
  python3 -I - <<'PY'
import os, pwd, stat
src, dst = '/srv/gbrain-eval/auth', '/srv/chatgpt-plan-bridge/auth'
ev, cb = pwd.getpwnam('gbrain-eval'), pwd.getpwnam('cpbridge')
for d, u in ((src, ev), (dst, cb)):
    st = os.lstat(d)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != u.pw_uid: raise SystemExit(f'refuse dir {d}')
def read_nofollow(p):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != ev.pw_uid or st.st_nlink != 1: raise SystemExit(f'refuse {p}')
        return os.read(fd, 1 << 20)
    finally: os.close(fd)
for name in ('credentials.json', 'host.json'):
    data = read_nofollow(f'{src}/{name}')
    out = os.open(f'{dst}/{name}', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try: os.write(out, data); os.fsync(out); os.fchown(out, cb.pw_uid, cb.pw_gid)
    finally: os.close(out)
    if read_nofollow(f'{src}/{name}') != data: raise SystemExit(f'changed during move: {name}')
fd = os.open(f'{src}/credentials.json', os.O_WRONLY | os.O_NOFOLLOW)
try:
    st = os.fstat(fd)  # re-check on THIS handle: the eval user owns the directory and could have swapped the file
    if not stat.S_ISREG(st.st_mode) or st.st_uid != ev.pw_uid or st.st_nlink != 1: raise SystemExit('refuse overwrite')
    os.write(fd, b'\0' * st.st_size); os.fsync(fd)
finally: os.close(fd)
os.unlink(f'{src}/credentials.json')
print('sign-in moved to', dst)
PY
fi
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
curl -sS -o /dev/null -w 'no-secret status=%{http_code}\n' http://127.0.0.1:$PORT/v1/bridge/status
# The header goes through curl's config on stdin (printf is a builtin): the secret never appears in any argv.
printf 'header = "Authorization: Bearer %s"\n' "$(< /etc/chatgpt-plan-bridge/caller.secret)" | curl -sS -K - http://127.0.0.1:$PORT/v1/bridge/status; echo
step "installed $HEAD"
