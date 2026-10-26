#!/usr/bin/env bash
set -euo pipefail
# S552: own one per-run chain/jump; never flush the shared table or change other UIDs.
rules() {
  local uid=$1 resolver=$2 chain=$3 profile=${4:-evaluation} family=ip
  [[ $profile == evaluation || $profile == consent ]] || return 2
  [[ $uid =~ ^[0-9]+$ && $chain =~ ^s552_[a-zA-Z0-9_]+$ ]] || return 2
  [[ $resolver =~ ^[0-9a-fA-F.:]+$ ]] || return 2
  [[ $resolver != *:* ]] || family=ip6
  printf 'add chain inet filter %s\n' "$chain"
  printf 'add rule inet filter output meta skuid %s jump %s comment "%s"\n' "$uid" "$chain" "$chain"
  printf 'add rule inet filter %s ip daddr 127.0.0.1 tcp dport 8084 accept\n' "$chain"
  printf 'add rule inet filter %s %s daddr %s udp dport 53 accept\n' "$chain" "$family" "$resolver"
  printf 'add rule inet filter %s %s daddr %s tcp dport 53 accept\n' "$chain" "$family" "$resolver"
  if [[ $profile == consent ]]; then
    printf 'add rule inet filter %s ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport 1455 ct state established ct direction reply accept\n' "$chain"
  fi
  printf 'add rule inet filter %s ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } counter drop\n' "$chain"
  printf 'add rule inet filter %s ip6 daddr { ::/128, ::1/128, ::ffff:0:0/96, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8 } counter drop\n' "$chain"
  printf 'add rule inet filter %s tcp dport 443 accept\n' "$chain"
  printf 'add rule inet filter %s counter drop\n' "$chain"
}
if [[ ${1:-} == print-rules ]]; then rules "$2" "$3" "$4" "${5:-evaluation}"; exit; fi
[[ $(id -u) == 0 ]] || { printf 'root required\n' >&2; exit 1; }
mode=${1:-}
[[ $mode == rehearse || $mode == rehearse-consent || $mode == consent || $mode == run ]] || { printf 'usage: launch.sh rehearse|rehearse-consent|consent|run\nReal consent requires separate permission; no credential-copy fallback.\n' >&2; exit 2; }
profile=evaluation
[[ $mode != consent && $mode != rehearse-consent ]] || profile=consent
# This build brief authorizes local rehearsal on 134 only. Runtime on 122 requires its separate GO.
if [[ $mode == rehearse* ]]; then
  [[ $(hostname) == daedalus-01 ]] || { printf 'rehearsal is authorized on 134 only\n' >&2; exit 1; }
fi
src=$(cd "$(dirname "$0")/../.." && pwd)
root=/srv/gbrain-eval
run=s552_$(date -u +%Y%m%d%H%M%S)_$$
unit=gbrain-eval-${run//_/-}
installed=0
stub_pid=
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  systemctl stop "$unit.service" >/dev/null 2>&1 || true
  if [[ -n $stub_pid ]]; then kill "$stub_pid" 2>/dev/null || true; wait "$stub_pid" 2>/dev/null || true; fi
  if ((installed)) && nft list chain inet filter "$run" >/dev/null 2>&1; then
    while read -r handle; do nft delete rule inet filter output handle "$handle"; done < <(nft -j -a list chain inet filter output | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(str(x["rule"]["handle"]) for x in d["nftables"] if "rule" in x and x["rule"].get("comment")==sys.argv[1]))' "$run")
    nft delete chain inet filter "$run"
  fi
  local remaining
  remaining=$(nft -j -a list table inet filter | python3 -c 'import json,sys; d=json.load(sys.stdin); name=sys.argv[1]; print(sum(1 for x in d["nftables"] if any(isinstance(v,dict) and (v.get("name")==name or v.get("comment")==name or v.get("chain")==name) for v in x.values())))' "$run")
  printf 'cleanup run=%s owned_rules_and_chains=%s\n' "$run" "$remaining"
  [[ $remaining == 0 ]] || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! getent passwd gbrain-eval >/dev/null; then useradd --system --user-group --no-create-home --shell /usr/sbin/nologin gbrain-eval; fi
uid=$(id -u gbrain-eval)
[[ $(id -G gbrain-eval) == "$(id -g gbrain-eval)" ]] || { printf 'supplementary groups refused\n' >&2; exit 1; }
[[ $(getent passwd gbrain-eval | cut -d: -f7) == /usr/sbin/nologin ]] || exit 1
install -d -m 0755 -o root -g root "$root" "$root/code" "$root/corpus"
install -d -m 0700 -o gbrain-eval -g gbrain-eval "$root/out" "$root/auth"
# Do not reuse mutable runtime code or inherited secrets. Copies are root-owned, not a symlink to /root.
rsync -a --delete --exclude=.git --exclude=.env --exclude='.env.*' --exclude='*.tsbuildinfo' "$src/" "$root/code/"
chown -R root:root "$root/code" "$root/corpus"
chmod -R a-w,a+rX "$root/code" "$root/corpus"
git -C "$src" rev-parse HEAD > "$root/code/BUILD-HEAD"
chmod 0444 "$root/code/BUILD-HEAD"
if [[ $mode == rehearse* ]]; then
  python3 "$src/eval/chatgpt-plan/rehearsal.py" "$root/out/$run.ready" & stub_pid=$!
  for _ in {1..50}; do [[ -f $root/out/$run.ready ]] && break; kill -0 "$stub_pid"; sleep .1; done
  [[ -f $root/out/$run.ready ]] || { printf 'stub startup failed\n' >&2; exit 1; }
fi
resolver=$(python3 -c 'import ipaddress; p=open("/etc/resolv.conf").read().splitlines(); ns=[l.split()[1] for l in p if l.startswith("nameserver ")]; assert len(ns)==1,"one frozen resolver required"; print(ipaddress.ip_address(ns[0]))')
nft list table inet filter >/dev/null
installed=1
rules "$uid" "$resolver" "$run" "$profile" | nft -f -
printf 'installed run=%s uid=%s resolver=%s\n' "$run" "$uid" "$resolver"
nft -a list chain inet filter "$run"
properties=(--uid=gbrain-eval --gid=gbrain-eval -p ProtectHome=yes -p ProtectSystem=strict
 -p "ReadWritePaths=$root/out $root/auth" -p 'InaccessiblePaths=-/var/run/postgresql -/var/lib/postgresql /etc/ssh'
 -p PrivateTmp=yes -p NoNewPrivileges=yes -p 'RestrictAddressFamilies=AF_INET AF_INET6' -p MemoryMax=2G
 -p 'SupplementaryGroups=' -p UMask=0077 -p "WorkingDirectory=$root/code")
inside() {
 systemd-run --unit="$unit" --wait --pipe --collect "${properties[@]}" /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent TMPDIR="$root/out" /usr/local/bin/bun "$root/code/eval/chatgpt-plan/cli.ts" "$@"
}
if [[ $mode == rehearse* ]]; then
  inside probe-rehearsal "$root/out/$run.ready" "$profile"
elif [[ $mode == consent ]]; then
  inside login
else
  inside probe
fi
counter=$(nft -j list chain inet filter "$run" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(e["counter"].get("packets",0) for x in d["nftables"] for e in x.get("rule",{}).get("expr",[]) if "counter" in e))')
printf 'denial_drop_packets=%s\n' "$counter"
if [[ $mode != consent ]]; then ((counter>0)) || { printf 'drop counter did not rise\n' >&2; exit 1; }; fi
if [[ $mode == run ]]; then inside run; fi
