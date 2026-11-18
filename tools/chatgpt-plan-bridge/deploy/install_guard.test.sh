#!/bin/bash
# S603: install.sh guards on scratch roots (every case stops before any system change: refusals exit, and the passing
# case uses the S603_GUARDS_ONLY seam), plus repoint_config and the manifest's executable helpers.
# Usage: bash install_guard.test.sh     exit 0 = every case behaved.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; sed 's/^/    /' "$T/out" 2>/dev/null; fails=$((fails+1)); }
W=$T/repo; git init -q $W; g() { git -C $W -c user.name=t -c user.email=t@t "$@"; }
g commit -q --allow-empty -m base; BASE=$(g rev-parse HEAD); g commit -q --allow-empty -m next; NEXT=$(g rev-parse HEAD)
g checkout -q -b side $BASE; g commit -q --allow-empty -m side; SIDE=$(g rev-parse HEAD); g checkout -q --detach $NEXT
OPT=$T/opt; mkdir -p $OPT/$BASE; ln -s $OPT/$BASE $OPT/current
run() { OPTROOT=$OPT ETC=$T/etc S603_GUARDS_ONLY=1 bash "$HERE/install.sh" "$@" > "$T/out" 2>&1; }
expect() { local want=$1 pat=$2 name=$3; shift 3; run "$@"; local rc=$?; if { [[ $want == 0 && $rc == 0 ]] || [[ $want != 0 && $rc != 0 ]]; } && grep -q -- "$pat" "$T/out"; then ok "$name"; else bad "$name (rc=$rc)"; fi; }

expect 0 'GUARDS PASSED' 'paid descendant of the deployed bundle passes the guards' $W $NEXT paid
expect 1 'plan-mode install over a deployed bundle is unsupported' 'plan install over a deployed bundle refused' $W $NEXT plan
mkdir $OPT/$NEXT; ln -sfn $OPT/$NEXT $OPT/current; g checkout -q --detach $SIDE   # deployed NEXT; SIDE branched from BASE lacks it
expect 1 'does not contain the deployed' 'non-descendant refused' $W $SIDE paid
g checkout -q --detach $NEXT; ln -sfn $OPT/$BASE $OPT/current; rmdir $OPT/$NEXT
mkdir $OPT/$NEXT; expect 1 'already exists; a bundle is never rebuilt' 'existing <HEAD> bundle refused' $W $NEXT paid; rmdir $OPT/$NEXT
ln -sfn $T/elsewhere $OPT/current; expect 1 'unknown deployed identity' 'unknown deployed identity refused' $W $NEXT paid
ln -sfn $OPT/$BASE $OPT/current
echo x > $W/dirty; expect 1 'worktree not clean' 'dirty worktree refused' $W $NEXT paid; rm $W/dirty

source "$HERE/canary_lib.sh"
C=$T/config.json; O=$OPT/$BASE; N=$OPT/$NEXT
printf '{"port": 18795, "upstream": {"auth": "api_key", "request_ms": 123456}, "leak": {"redactor": "%s/detectors/redactor.py", "detector_check": "%s/detectors/detector_check.py", "timeout_ms": 777}, "custom": "keep-me"}' $O $O > $C
if repoint_config $C $O $N > $T/out 2>&1 && python3 -I -c "
import json,sys; c=json.load(open('$C'))
assert c['leak']['redactor']=='$N/detectors/redactor.py' and c['leak']['detector_check']=='$N/detectors/detector_check.py'
assert c['custom']=='keep-me' and c['upstream']['request_ms']==123456 and c['leak']['timeout_ms']==777
" && [[ $(stat -c %a $C) == 640 ]]; then ok 'repoint: only the two detector paths change; other settings kept; mode 640'; else bad 'repoint'; fi
cp $C $T/before; if repoint_config $C $O $N > $T/out 2>&1; then bad 'repoint of a config whose paths are not the deployed bundle'; else cmp -s $C $T/before && ok 'repoint: foreign detector paths refused, file untouched' || bad 'repoint refused but file changed'; fi
printf '{"upstream": {}, "leak": {"redactor": "%s/detectors/redactor.py", "detector_check": "%s/detectors/detector_check.py"}}' $O $O > $C
repoint_config $C $O $N > $T/out 2>&1 && bad 'repoint of a plan config' || ok 'repoint: non-paid config refused'

B=$T/bundle; mkdir -p $B/detectors; for f in bridge.js bun egress.sh init_spend.py detectors/redactor.py; do echo "$f" > $B/$f; done
GITLEAKS=$T/gl; echo gl > $GITLEAKS; manifest_of $B > $T/m
for f in egress.sh init_spend.py; do cp $B/$f $T/keep; echo mutated >> $B/$f; manifest_ok $B $T/m 2>/dev/null && bad "manifest: $f mutation accepted" || ok "manifest: $f mutation refused"; cp $T/keep $B/$f; done
manifest_ok $B $T/m && ok 'manifest: restored bundle matches' || bad 'manifest restore'

echo "$fails failure(s)"; exit $(( fails > 0 ))
