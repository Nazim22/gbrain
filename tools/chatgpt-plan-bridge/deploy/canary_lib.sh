# Sourced by paid-canary.sh (and its offline test). Commands are variables so the test can replace them.
: "${SYSTEMCTL:=systemctl}" "${PGREP:=pgrep}" "${NFT:=nft}" "${SLEEP:=sleep}"
# Stop the canary unit and PROVE nothing of the bridge user runs. Returns 0 only when the unit is not active AND no
# cpbridge process exists; anything else (stop failed, still active, a survivor, an unreadable state) returns 1.
canary_ceased() {   # <unit>
  local unit=$1 st i
  $SYSTEMCTL stop "$unit.service" >/dev/null 2>&1
  for i in $(seq 20); do
    st=$($SYSTEMCTL is-active "$unit.service" 2>/dev/null)
    if [[ $st == inactive || $st == failed ]] && ! $PGREP -u cpbridge >/dev/null 2>&1; then return 0; fi
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
    "$egress" remove && rm -f "$cfg"
    $SYSTEMCTL reset-failed "$unit.service" 2>/dev/null
    echo "== cleanup: canary bridge stopped (proven), egress fence removed, canary config removed"
    return "$rc"
  fi
  echo "== cleanup: STOP. The canary bridge could NOT be proven stopped. The egress fence and canary config are LEFT IN PLACE."
  echo "   Stop it by hand (systemctl stop $unit.service; pgrep -u cpbridge), then: $egress remove; rm $cfg"
  [[ $rc != 0 ]] || rc=1
  return "$rc"
}
