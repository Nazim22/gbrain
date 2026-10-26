#!/bin/bash
# verify_live.py: the live bridge verifies; each confinement break in a copy of the live nft listing, and a bound file newer
# than the running process, is refused. Read-only on the live system. Usage: verify_live.test.sh   (root, bridge running)
set -u
W=$(cd "$(dirname "$0")/../../.." && pwd); V="$W/tools/chatgpt-plan-bridge/deploy/verify_live.py"; FAILS=0
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
expect() { if [[ $2 == "$3" ]]; then echo "OK   $1"; else echo "FAIL $1 (rc=$2, want $3): $(tail -2 "$T/out")"; FAILS=$((FAILS+1)); fi; }
nftcase() { python3 -I -c "import sys,re; t=open('$T/live.nft').read(); exec(sys.argv[1]); open('$T/case.nft','w').write(t)" "$1"
  python3 -I "$V" "$W" --nft-file "$T/case.nft" > "$T/out" 2>&1; rc=$?   # a refusal must be the nft check's own, never a crash
  [[ $rc == 0 ]] || grep -q '^REFUSE: nft chain' "$T/out" || rc=99; echo $rc; }
python3 -I "$V" "$W" > "$T/out" 2>&1; expect "live bridge verifies" $? 0
nft list table inet filter > "$T/live.nft"
expect "unmodified live listing verifies"   "$(nftcase 'pass')" 0
expect "orphan chain (gate removed)"         "$(nftcase "t=re.sub(r'\tchain cpbridge_egress_gate \{.*?\n\t\}\n', '', t, flags=re.S)")" 1
expect "gate re-hooked to input"             "$(nftcase "t=t.replace('hook output priority filter - 10', 'hook input priority filter - 10')")" 1
expect "gate priority changed"               "$(nftcase "t=t.replace('priority filter - 10', 'priority filter')")" 1
expect "accept before the drop"              "$(nftcase "t=re.sub(r'(\n\t\tcounter packets \d+ bytes \d+ drop)', r'\n\t\taccept\1', t)")" 1
expect "extra accept in the gate before the jump" "$(nftcase "t=re.sub(r'(\n\t\tmeta skuid)', r'\n\t\tmeta skuid 993 accept\1', t, count=1)")" 1
expect "another uid jumped"                  "$(nftcase "t=re.sub(r'meta skuid \d+ jump', 'meta skuid 0 jump', t)")" 1
expect "allow rules reordered"               "$(nftcase "a='\t\tip daddr @cpbridge_egress_v4 tcp dport 443 accept\n'; b='\t\tip6 daddr @cpbridge_egress_v6 tcp dport 443 accept\n'; t=t.replace(a+b, b+a)")" 1
opt=$(readlink -f /opt/chatgpt-plan-bridge/current); cp -a "$opt" "$T/opt"; touch -d '+1 hour' "$T/opt/bridge.js"
python3 -I "$V" "$W" --opt "$T/opt" > "$T/out" 2>&1; rc=$?; grep -q 'newer than the running process' "$T/out" || rc=99
expect "a bound file newer than the running process" $rc 1
echo "RESULT: $FAILS failure(s)"; exit $FAILS
