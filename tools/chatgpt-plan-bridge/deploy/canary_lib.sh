# Sourced by install.sh (paid), paid-canary.sh, rollback-paid.sh and the offline test. Commands are variables so the test
# can replace them.
: "${SYSTEMCTL:=systemctl}" "${PGREP:=pgrep}" "${NFT:=nft}" "${SLEEP:=sleep}"
# Is any process of the bridge user running? pgrep: 0 = yes, 1 = none, anything else = the question could not be answered.
# Returns 0 ONLY for a proven "none"; 1 for "yes"; 2 for "unknown". Callers treat 1 and 2 alike: not proven absent.
no_bridge_process() {
  local rc=0
  $PGREP -u cpbridge >/dev/null 2>&1 || rc=$?
  case $rc in 1) return 0;; 0) return 1;; *) return 2;; esac
}
# The step-0 output of the OLD verifier is a usable rollback reference only if it got through every bundle, runtime,
# helper and unit check and then either verified or stopped at config.json. An earlier refusal is not a baseline.
baseline_stage_ok() {   # <verify-baseline file>
  local f=$1 want
  for want in 'ok  installed dir ' 'ok  bridge.js (fresh bundle of the reviewed tools)' 'ok  bun runtime' 'ok  detector_check.py' 'ok  egress.sh' \
      'ok  chatgpt-plan-bridge.service' 'ok  chatgpt-plan-bridge-egress.service' 'ok  chatgpt-plan-bridge-egress.timer'; do
    grep -qF -- "$want" "$f" || { echo "baseline lacks: $want"; return 1; }
  done
  [[ $(grep -c '^REFUSE' "$f") -le 1 ]] || { echo "baseline has more than one refusal"; return 1; }
  if grep -q '^REFUSE' "$f"; then
    [[ $(tail -n 1 "$f") == 'REFUSE: config.json differs from install.sh for '* ]] || { echo "baseline stops before config.json: $(grep '^REFUSE' "$f" | cut -c1-120)"; return 1; }
  else
    [[ $(tail -n 1 "$f") == 'VERIFIED: the installed bridge is the reviewed bytes' ]] || { echo "baseline neither verified nor refused at config.json"; return 1; }
  fi
}
# Stop the canary unit and PROVE nothing of the bridge user runs. Returns 0 only when the unit is not active AND no
# cpbridge process exists; anything else (stop failed, still active, a survivor, an unreadable state) returns 1.
canary_ceased() {   # <unit>
  local unit=$1 st i
  $SYSTEMCTL stop "$unit.service" >/dev/null 2>&1
  for i in $(seq 20); do
    st=$($SYSTEMCTL is-active "$unit.service" 2>/dev/null)
    if [[ $st == inactive || $st == failed ]] && no_bridge_process; then return 0; fi
    $SLEEP 1
  done
  return 1
}
# Exit path of the canary. The egress fence and the canary config are removed ONLY after cessation is proven; if it is
# not, both stay in place (a running bridge keeps its fence) and the exit status is forced non-zero whatever came before.
canary_cleanup() {   # <incoming-rc> <unit> <egress.sh> <canary-config> <evidence-dir>
  local rc=$1 unit=$2 egress=$3 cfg=$4 out=$5
  if canary_ceased "$unit"; then
    $NFT list chain inet filter cpbridge_egress > "$out/egress-chain-at-end.txt" 2>&1
    $SYSTEMCTL reset-failed "$unit.service" 2>/dev/null
    if "$egress" remove && rm -f "$cfg" && [[ ! -e $cfg ]]; then
      echo "== cleanup: canary bridge stopped (proven), egress fence removed, canary config removed"
      return "$rc"
    fi
    echo "== cleanup: the canary bridge is stopped (proven) but TEARDOWN FAILED: the egress fence and/or $cfg may still be there."
    echo "   Finish by hand: $egress remove; rm $cfg"
    [[ $rc != 0 ]] || rc=1
    return "$rc"
  fi
  echo "== cleanup: STOP. The canary bridge could NOT be proven stopped. The egress fence and canary config are LEFT IN PLACE."
  echo "   Stop it by hand (systemctl stop $unit.service; pgrep -u cpbridge), then: $egress remove; rm $cfg"
  [[ $rc != 0 ]] || rc=1
  return "$rc"
}

# ---- S603: deploy identity, ancestry, manifests, atomic swap and running-process binding ------------------------------
# Every function takes its roots as arguments (tests run them on scratch dirs) and prints REFUSE/STOP reasons itself.
: "${PROC:=/proc}" "${GITLEAKS:=/usr/local/bin/gitleaks}"

# The sha the deployed 'current' names. Only <optroot>/<40-hex> is a known identity; anything else refuses.
deployed_sha() {   # <optroot>
  local t; t=$(readlink "$1/current") || { echo "REFUSE: $1/current is not a symlink" >&2; return 1; }
  [[ $t =~ ^$1/([0-9a-f]{40})$ && -d $t && ! -L $t ]] || { echo "REFUSE: unknown deployed identity ($t)" >&2; return 1; }
  echo "${BASH_REMATCH[1]}"
}
# Forward installs only: the candidate must contain what is deployed now (no silent rollback of a live fix).
require_descendant() {   # <repo> <deployed-sha> <head-sha>
  git -C "$1" cat-file -e "$2^{commit}" 2>/dev/null || { echo "REFUSE: deployed commit $2 is not in this repo (unknown identity)" >&2; return 1; }
  git -C "$1" merge-base --is-ancestor "$2" "$3" || { echo "REFUSE: $3 does not contain the deployed $2 (use --rollback-to for a deliberate rollback)" >&2; return 1; }
}
# Hashes of every file the bundle runs with, relative to the bundle dir, plus the system gitleaks by absolute path.
manifest_of() {   # <bundle-dir>
  (cd "$1" && sha256sum bridge.js bun detectors/* && sha256sum "$GITLEAKS")
}
manifest_ok() {   # <bundle-dir> <manifest-file>
  (cd "$1" && sha256sum --quiet -c "$2") || { echo "REFUSE: $1 does not match $2" >&2; return 1; }
}
# rename(2) over the old link: 'current' names the old bundle or the new one, never neither.
atomic_current() {   # <optroot> <sha>
  local tmp="$1/.current.new.$$"
  rm -f "$tmp"; ln -s "$1/$2" "$tmp" && mv -T "$tmp" "$1/current"
}
# Process start in epoch seconds from /proc/<pid>/stat field 22 (clock ticks since boot) + btime.
proc_start_epoch() {   # <pid>
  local ticks btime hz
  ticks=$(sed -E 's/^.*\) //' "$PROC/$1/stat" | awk '{print $20}') || return 1
  btime=$(awk '/^btime /{print $2}' "$PROC/stat") || return 1
  hz=${CLK_TCK:-$(getconf CLK_TCK)}
  echo $(( btime + ticks / hz ))
}
# Accept the running bridge only when script, start time, interpreter and effective config all bind to <bundle>.
bind_running() {   # <pid> <optroot> <sha> <config-path> <pinned-config-sha256> <swap-epoch>
  local pid=$1 opt=$2 sha=$3 cfg=$4 pin=$5 swap=$6 b="$2/$3" want got start
  want=$(printf '%s\0' "$opt/current/bun" "$opt/current/bridge.js" "$cfg" | od -An -c | tr -d ' \n')
  got=$(od -An -c "$PROC/$pid/cmdline" | tr -d ' \n')
  [[ $got == "$want" ]] || { echo "STOP: cmdline is not <current>/bun <current>/bridge.js $cfg" >&2; return 1; }
  [[ $(readlink -f "$opt/current") == "$b" ]] || { echo "STOP: current does not resolve to $b" >&2; return 1; }
  start=$(proc_start_epoch "$pid") || { echo "STOP: cannot read the process start time" >&2; return 1; }
  (( start >= swap )) || { echo "STOP: process started before the swap ($start < $swap): it may run the old script" >&2; return 1; }
  [[ $(readlink "$PROC/$pid/exe") == "$b/bun" ]] || { echo "STOP: interpreter is not $b/bun" >&2; return 1; }
  [[ $(sha256sum < "$cfg" | cut -c1-64) == "$pin" ]] || { echo "STOP: config bytes differ from the pinned config" >&2; return 1; }
  python3 -I - "$cfg" "$b" <<'PY' || { echo "STOP: config detectors are not this bundle's" >&2; return 1; }
import hashlib, json, sys
c = json.load(open(sys.argv[1]))['leak']; b = sys.argv[2]
assert c['redactor'] == f'{b}/detectors/redactor.py' and c['detector_check'] == f'{b}/detectors/detector_check.py'
assert hashlib.sha256(open(c['redactor'], 'rb').read()).hexdigest() == c['redactor_sha256']
PY
}
