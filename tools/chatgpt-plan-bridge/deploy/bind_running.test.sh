#!/bin/bash
# S603: bind_running / deployed_sha / require_descendant / manifest / atomic_current on scratch roots and a fake /proc.
# Usage: bash bind_running.test.sh    exit 0 = every case behaved.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
expect() { local want=$1 name=$2; shift 2; if "$@" >/dev/null 2>&1; then [[ $want == accept ]] && ok "$name" || bad "$name (accepted)"; else [[ $want == reject ]] && ok "$name" || bad "$name (rejected)"; fi; }

export PROC=$T/proc GITLEAKS=$T/gitleaks CLK_TCK=100
source "$HERE/canary_lib.sh"
OPT=$T/opt; A=$(printf 'a%.0s' {1..40}); B=$(printf 'b%.0s' {1..40}); echo gl > $GITLEAKS
for s in $A $B; do mkdir -p $OPT/$s/detectors; echo "js-$s" > $OPT/$s/bridge.js; echo bun > $OPT/$s/bun; echo "redactor-$s" > $OPT/$s/detectors/redactor.py; echo dc > $OPT/$s/detectors/detector_check.py; echo eg > $OPT/$s/egress.sh; echo is > $OPT/$s/init_spend.py; done
ln -s $OPT/$B $OPT/current
cfg() { python3 -I -c "import hashlib,json,sys; b=sys.argv[1]; r=f'{b}/detectors/redactor.py'; print(json.dumps({'leak':{'redactor':r,'detector_check':f'{b}/detectors/detector_check.py','redactor_sha256':hashlib.sha256(open(r,'rb').read()).hexdigest()}}))" "$1"; }
CFG=$T/config.json; cfg $OPT/$B > $CFG; PIN=$(sha256sum < $CFG | cut -c1-64)
mkdir -p $PROC/42; echo "btime 1000" > $PROC/stat
printf '%s\0' "$OPT/current/bun" "$OPT/current/bridge.js" "$CFG" > $PROC/42/cmdline
fields=$(printf '0 %.0s' {1..18}); echo "42 (bun) S $fields 50000 0" > $PROC/42/stat   # field 22 = 50000 ticks = 500 s -> start 1500
ln -s $OPT/$B/bun $PROC/42/exe

expect accept 'bind: everything matches' bind_running 42 $OPT $B $CFG $PIN 1500
printf '%s\0' "$OPT/$A/bun" "$OPT/$A/bridge.js" "$CFG" > $PROC/42/cmdline
expect reject 'bind: old script path in cmdline' bind_running 42 $OPT $B $CFG $PIN 1500
printf '%s\0' "$OPT/current/bun" "$OPT/current/bridge.js" "$CFG" > $PROC/42/cmdline
expect reject 'bind: process started before the swap' bind_running 42 $OPT $B $CFG $PIN 1501
ln -sfn $OPT/$A $OPT/current
expect reject 'bind: current resolves elsewhere' bind_running 42 $OPT $B $CFG $PIN 1500
ln -sfn $OPT/$B $OPT/current
cp $CFG $T/cfg.bak; printf ' ' >> $CFG
expect reject 'bind: config off by one byte' bind_running 42 $OPT $B $CFG $PIN 1500
cfg $OPT/$A > $CFG; expect reject 'bind: detector paths in another bundle (pin matched)' bind_running 42 $OPT $B $CFG "$(sha256sum < $CFG | cut -c1-64)" 1500
cp $T/cfg.bak $CFG
ln -sfn $OPT/$A/bun $PROC/42/exe; expect reject 'bind: interpreter from another bundle' bind_running 42 $OPT $B $CFG $PIN 1500
ln -sfn $OPT/$B/bun $PROC/42/exe

expect accept 'identity: current -> <opt>/<40hex>' deployed_sha $OPT
ln -sfn $T/elsewhere $OPT/current; expect reject 'identity: current -> unknown target' deployed_sha $OPT
ln -sfn $OPT/$B $OPT/current

manifest_of $OPT/$B > $T/m; expect accept 'manifest: matches' manifest_ok $OPT/$B $T/m
echo x >> $OPT/$B/detectors/redactor.py; expect reject 'manifest: one file changed' manifest_ok $OPT/$B $T/m

atomic_current $OPT $A; [[ $(readlink $OPT/current) == $OPT/$A && ! -e $OPT/.current.new.$$ ]] && ok 'swap: current renamed onto the new target' || bad 'swap'

R=$T/repo; git init -q $R; git -C $R -c user.name=t -c user.email=t@t commit -q --allow-empty -m base; base=$(git -C $R rev-parse HEAD)
git -C $R -c user.name=t -c user.email=t@t commit -q --allow-empty -m next; next=$(git -C $R rev-parse HEAD)
git -C $R checkout -q -b side $base; git -C $R -c user.name=t -c user.email=t@t commit -q --allow-empty -m side; side=$(git -C $R rev-parse HEAD)
expect accept 'ancestry: descendant' require_descendant $R $base $next
expect reject 'ancestry: divergent branch' require_descendant $R $next $side
expect reject 'ancestry: unknown deployed commit' require_descendant $R $(printf 'c%.0s' {1..40}) $next

echo "$fails failure(s)"; exit $(( fails > 0 ))
