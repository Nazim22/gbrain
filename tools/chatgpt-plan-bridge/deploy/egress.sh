#!/bin/bash
# Per-uid egress for the bridge user (pattern of the reviewed eval launcher): DNS to the one frozen resolver, replies on
# our own loopback listener, 443 to public addresses only; private/loopback/link-local/multicast ranges dropped.
set -euo pipefail
CHAIN=cpbridge_egress PORT=${CPBRIDGE_PORT:-18795}
uid=$(id -u cpbridge)
case "${1:-}" in
  add)
    resolver=$(python3 -c 'import ipaddress; p=open("/etc/resolv.conf").read().splitlines(); ns=[l.split()[1] for l in p if l.startswith("nameserver ")]; assert len(ns)==1,"one frozen resolver required"; print(ipaddress.ip_address(ns[0]))')
    fam=ip; [[ $resolver != *:* ]] || fam=ip6
    "$0" remove || true
    nft -f - <<EOF
add chain inet filter $CHAIN
add chain inet filter ${CHAIN}_gate { type filter hook output priority -10; policy accept; }
add rule inet filter ${CHAIN}_gate meta skuid $uid jump $CHAIN comment "$CHAIN"
add rule inet filter $CHAIN ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport $PORT ct state established accept
add rule inet filter $CHAIN $fam daddr $resolver udp dport 53 accept
add rule inet filter $CHAIN $fam daddr $resolver tcp dport 53 accept
add rule inet filter $CHAIN ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } counter drop
add rule inet filter $CHAIN ip6 daddr { ::/128, ::1/128, ::ffff:0:0/96, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8 } counter drop
add rule inet filter $CHAIN tcp dport 443 accept
add rule inet filter $CHAIN counter drop
EOF
    ;;
  remove)
    if nft list chain inet filter "${CHAIN}_gate" >/dev/null 2>&1; then nft delete chain inet filter "${CHAIN}_gate"; fi
    if nft list chain inet filter "$CHAIN" >/dev/null 2>&1; then nft delete chain inet filter "$CHAIN"; fi
    ;;
  *) echo "usage: egress.sh add|remove" >&2; exit 2;;
esac
