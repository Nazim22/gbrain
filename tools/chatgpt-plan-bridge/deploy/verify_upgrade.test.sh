#!/bin/bash
# S603: verify_install.py after an UPGRADE accepts the preserved config (pinned pre-upgrade config, only detector paths
# moved), and refuses a changed setting, a tampered pin, and (with no pin) a non-template config.
# Builds a scratch upgraded install from THIS worktree in a root-only temp dir; the live /etc config dir is copied there
# exactly as verify_install.test.sh does (read-only on the live install). The scratch root sits under /root/work because
# key custody refuses any group/other-writable ancestor such as /tmp. Usage: verify_upgrade.test.sh (root)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); W=$(cd "$HERE/../../.." && pwd); V="$HERE/verify_install.py"
T=$(mktemp -d -p /root/work s603-verify-upgrade.XXXXXX); trap 'rm -rf "$T"' EXIT; fails=0
expect() { local name=$1 want=$2; python3 -I "$V" "$W" paid "$T/opt" "$T/etc" "$T/units" > "$T/out" 2>&1; local rc=$?
  if [[ $rc == "$want" ]]; then echo "PASS $name"; else echo "FAIL $name (rc=$rc, want $want)"; sed 's/^/    /' "$T/out" | tail -4; fails=$((fails+1)); fi; }
source "$HERE/canary_lib.sh"
OLD=$(printf 'a%.0s' {1..40}); NEW=$(printf 'b%.0s' {1..40})
mkdir -p "$T/opt/$OLD/detectors" "$T/opt/$NEW/detectors" "$T/units"
(cd "$W" && /root/.bun/bin/bun build tools/chatgpt-plan-bridge/main.ts --target=bun --outfile "$T/opt/$NEW/bridge.js" >/dev/null)
install -m 0755 "$(readlink -f /root/.bun/bin/bun)" "$T/opt/$NEW/bun"
install -m 0644 "$W/tools/chatgpt-plan-bridge/detector_check.py" "$T/opt/$NEW/detectors/detector_check.py"
install -m 0644 /root/work/dream-s552-vault-atoms/pilot/detector/ingest-session-transcript.py "$T/opt/$NEW/detectors/redactor.py"
install -m 0755 "$HERE/egress.sh" "$T/opt/$NEW/egress.sh"; install -m 0644 "$HERE/init_spend.py" "$T/opt/$NEW/init_spend.py"
ln -s "$T/opt/$NEW" "$T/opt/current"
cp -a /etc/systemd/system/chatgpt-plan-bridge.service /etc/systemd/system/chatgpt-plan-bridge-egress.service /etc/systemd/system/chatgpt-plan-bridge-egress.timer "$T/units/"
setup() {   # <extra python statement applied to the pre-upgrade config>
  rm -rf "$T/etc"; cp -a /etc/chatgpt-plan-bridge "$T/etc"
  python3 -I - "$T/etc/config.json" "$T/opt/$OLD" "$1" <<'PY'
import json, re, sys
p, old, extra = sys.argv[1:]
c = json.load(open(p))
for k, f in (('redactor', 'redactor.py'), ('detector_check', 'detector_check.py')):
    c['leak'][k] = f'{old}/detectors/{f}'
c['upstream']['api_key_file'] = p.rsplit('/', 1)[0] + '/openai-api.key'   # custody check: the key must sit under this config dir
exec(extra)
json.dump(c, open(p, 'w'))
PY
  cp -p "$T/etc/config.json" "$T/etc/rollback.config.json"
  { echo "# sha $OLD"; echo "# config $(sha256sum < "$T/etc/rollback.config.json" | cut -c1-64)"; } > "$T/etc/rollback.manifest"
  echo forward > "$T/etc/swap.mode"
  repoint_config "$T/etc/config.json" "$T/opt/$OLD" "$T/opt/$NEW" > /dev/null
  chown root:cpbridge "$T/etc/config.json"; chmod 0640 "$T/etc/config.json"
}
setup "c['upstream']['request_ms'] = 123456"
expect 'upgrade with a preserved non-template setting verifies' 0
grep -q 'ok  upgrade from' "$T/out" || { echo "FAIL upgrade branch not taken"; fails=$((fails+1)); }
setup "c['upstream']['request_ms'] = 123456"
python3 -I -c "import json,sys; p=sys.argv[1]; c=json.load(open(p)); c['upstream']['request_ms']=999; json.dump(c,open(p,'w'))" "$T/etc/config.json"
expect 'a setting changed after the pin is refused' 1
setup "pass"; printf ' ' >> "$T/etc/rollback.config.json"
expect 'a tampered pinned config is refused' 1
setup "c['upstream']['request_ms'] = 123456"; rm "$T/etc/rollback.manifest"
expect 'no upgrade pin: a non-template config is refused (template still governs fresh installs)' 1
echo "$fails failure(s)"; exit $(( fails > 0 ))
