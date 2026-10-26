#!/bin/bash
# Per-uid egress for the bridge user (pattern of the reviewed eval launcher), OpenAI-only:
#   DNS to the one frozen resolver; replies on our own loopback listener; TCP/443 ONLY to the addresses that
#   api.openai.com and auth.openai.com resolve to (nft sets with timed elements, refreshed by a root timer);
#   everything else dropped and counted.
# Usage: egress.sh add | refresh | remove
set -euo pipefail
CHAIN=cpbridge_egress PORT=${CPBRIDGE_PORT:-18795} HOSTS="api.openai.com auth.openai.com" TTL=2h
uid=$(id -u cpbridge)
refresh() {
  local n4=0 n6=0 a
  for h in $HOSTS; do
    for a in $(getent ahostsv4 "$h" | awk '{print $1}' | sort -u); do nft add element inet filter ${CHAIN}_v4 "{ $a timeout $TTL }"; n4=$((n4+1)); done
    for a in $(getent ahostsv6 "$h" | awk '$1 ~ /:/ {print $1}' | sort -u); do nft add element inet filter ${CHAIN}_v6 "{ $a timeout $TTL }"; n6=$((n6+1)); done
  done
  ((n4 + n6 > 0)) || { echo "egress refresh: no OpenAI address resolved" >&2; exit 1; }
  echo "egress refresh: v4=$n4 v6=$n6"
}
case "${1:-}" in
  add)
    resolver=$(python3 -c 'import ipaddress; p=open("/etc/resolv.conf").read().splitlines(); ns=[l.split()[1] for l in p if l.startswith("nameserver ")]; assert len(ns)==1,"one frozen resolver required"; print(ipaddress.ip_address(ns[0]))')
    fam=ip; [[ $resolver != *:* ]] || fam=ip6
    "$0" remove || true
    nft -f - <<EOF
add set inet filter ${CHAIN}_v4 { type ipv4_addr; flags timeout; }
add set inet filter ${CHAIN}_v6 { type ipv6_addr; flags timeout; }
add chain inet filter $CHAIN
add chain inet filter ${CHAIN}_gate { type filter hook output priority -10; policy accept; }
add rule inet filter ${CHAIN}_gate meta skuid $uid jump $CHAIN comment "$CHAIN"
add rule inet filter $CHAIN ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport $PORT ct state established accept
add rule inet filter $CHAIN $fam daddr $resolver udp dport 53 accept
add rule inet filter $CHAIN $fam daddr $resolver tcp dport 53 accept
add rule inet filter $CHAIN ip daddr @${CHAIN}_v4 tcp dport 443 accept
add rule inet filter $CHAIN ip6 daddr @${CHAIN}_v6 tcp dport 443 accept
add rule inet filter $CHAIN counter drop
EOF
    refresh
    ;;
  refresh) refresh ;;
  remove)
    for c in "${CHAIN}_gate" "$CHAIN"; do if nft list chain inet filter "$c" >/dev/null 2>&1; then nft delete chain inet filter "$c"; fi; done
    for s in "${CHAIN}_v4" "${CHAIN}_v6"; do if nft list set inet filter "$s" >/dev/null 2>&1; then nft delete set inet filter "$s"; fi; done
    ;;
  *) echo "usage: egress.sh add|refresh|remove" >&2; exit 2;;
esac
