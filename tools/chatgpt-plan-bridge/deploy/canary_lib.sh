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
