#!/bin/bash
# move_signin.py scenarios in temp dirs (same user on both sides; ownership checks still run).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); U=$(id -un); FAILS=0
T=$(mktemp -d "${TMPDIR:-/tmp}/move-signin-XXXX"); trap 'rm -rf "$T"' EXIT
mv_() { python3 -I "$HERE/move_signin.py" "$T/src" "$T/dst" "$U" "$U" 2>&1; }
fresh() { rm -rf "$T/src" "$T/dst"; mkdir -m 700 "$T/src" "$T/dst"; printf 'CRED-1' > "$T/src/credentials.json"; printf 'HOST' > "$T/src/host.json"; : > "$T/src/refresh.lock"; chmod 600 "$T/src/"*; }
expect() { if [[ "$2" == *"$3"* ]]; then echo "OK   $1"; else echo "FAIL $1: wanted '$3' in: $2"; FAILS=$((FAILS+1)); fi; }

fresh; out=$(mv_); expect "fresh move" "$out" "DONE (moved)"
expect "source credentials gone" "$(ls "$T/src")" "host.json"; [[ -e "$T/src/credentials.json" ]] && { echo "FAIL source credentials still present"; FAILS=$((FAILS+1)); }
expect "destination has the credentials" "$(cat "$T/dst/credentials.json")" "CRED-1"
out=$(mv_); expect "re-run is idempotent" "$out" "DONE (already moved)"

fresh; cp -p "$T/src/host.json" "$T/dst/host.json"; out=$(mv_); expect "partial destination (host only) is redone" "$out" "DONE (moved)"
fresh; printf 'X' > "$T/dst/.credentials.json.moving"; chmod 600 "$T/dst/.credentials.json.moving"; out=$(mv_); expect "leftover temp is cleaned and redone" "$out" "DONE (moved)"
fresh; cp -p "$T/src/host.json" "$T/src/credentials.json" "$T/dst/"; out=$(mv_); expect "interrupted after copy: finishes by wiping source" "$out" "source wiped"
fresh; cp -p "$T/src/host.json" "$T/dst/"; printf 'CRED-2' > "$T/dst/credentials.json"; chmod 600 "$T/dst/credentials.json"; out=$(mv_); expect "different grants on both sides refuse" "$out" "DIFFERENT"
fresh; : > "$T/src/refresh.pending"; out=$(mv_); expect "pending refresh refuses" "$out" "pending"
fresh; rm "$T/src/credentials.json"; ln -s /etc/hostname "$T/src/credentials.json"; out=$(mv_); expect "symlinked source refuses" "$out" "REFUSE"
fresh; rm "$T/src/refresh.lock"; ln -s /etc/hostname "$T/src/refresh.lock"; out=$(mv_); expect "symlinked lock refuses" "$out" "REFUSE"
fresh; ( exec 9<"$T/src/refresh.lock"; flock -x 9; sleep 2 ) & sleep 0.3; start=$(date +%s%N); out=$(mv_); waited=$(( ($(date +%s%N) - start) / 1000000 ))
expect "move waits for a held refresh lock" "waited_ms=$waited $out" "DONE (moved)"; (( waited >= 1200 )) || { echo "FAIL lock not honoured (waited ${waited}ms)"; FAILS=$((FAILS+1)); }; wait
echo "RESULT: $FAILS failure(s)"; exit $FAILS
