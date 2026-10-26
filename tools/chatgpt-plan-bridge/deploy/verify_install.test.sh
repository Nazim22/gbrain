#!/bin/bash
# verify_install.py: the live install verifies; a scratch copy verifies; one changed byte (or a re-pointed dir) in any bound
# artifact is refused. Read-only on the live install. Usage: verify_install.test.sh   (root, after install.sh)
set -u
W=$(cd "$(dirname "$0")/../../.." && pwd); V="$W/tools/chatgpt-plan-bridge/deploy/verify_install.py"; FAILS=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
expect() { if [[ $2 == "$3" ]]; then echo "OK   $1"; else echo "FAIL $1 (rc=$2, want $3)"; FAILS=$((FAILS+1)); fi; }
run() { python3 -I "$V" "$W" "$T/opt" "$T/etc" "$T/units" > "$T/out" 2>&1; echo $?; }
python3 -I "$V" "$W" > "$T/live" 2>&1; expect "live install verifies" $? 0
opt=$(readlink /opt/chatgpt-plan-bridge/current); sha=$(basename "$opt")
reset() { rm -rf "$T/opt" "$T/etc" "$T/units"; mkdir -p "$T/opt" "$T/units"; cp -a "$opt" "$T/opt/$sha"; ln -s "$T/opt/$sha" "$T/opt/current"
  cp -a /etc/chatgpt-plan-bridge "$T/etc"; sed -i "s#/opt/chatgpt-plan-bridge/$sha#$T/opt/$sha#g" "$T/etc/config.json"
  cp -a /etc/systemd/system/chatgpt-plan-bridge.service /etc/systemd/system/chatgpt-plan-bridge-egress.service /etc/systemd/system/chatgpt-plan-bridge-egress.timer "$T/units/"; }
flip() { printf 'X' | dd of="$1" bs=1 seek=100 conv=notrunc status=none; }
reset; expect "scratch copy verifies" "$(run)" 0
reset; flip "$T/opt/$sha/bridge.js";                expect "changed bridge.js refused" "$(run)" 1
reset; flip "$T/opt/$sha/detectors/redactor.py";    expect "changed redactor refused" "$(run)" 1
reset; flip "$T/opt/$sha/detectors/detector_check.py"; expect "changed detector_check refused" "$(run)" 1
reset; flip "$T/opt/$sha/egress.sh";                expect "changed egress.sh refused" "$(run)" 1
reset; flip "$T/units/chatgpt-plan-bridge.service"; expect "changed unit refused" "$(run)" 1
reset; sed -i 's/"per_hour": 600/"per_hour": 6000/' "$T/etc/config.json"; expect "changed config refused" "$(run)" 1
reset; chmod 0644 "$T/etc/caller.secret";           expect "loosened secret mode refused" "$(run)" 1
reset; mkdir "$T/opt/other"; ln -sfn "$T/opt/other" "$T/opt/current"; expect "current -> non-sha dir refused" "$(run)" 1
echo "RESULT: $FAILS failure(s)"; exit $FAILS
