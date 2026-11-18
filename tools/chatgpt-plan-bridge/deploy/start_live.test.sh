#!/bin/bash
# S603: start_live.sh with fake systemctl / pgrep / curl / bind on scratch roots. The status JSON goes through the REAL
# status_check.py. Covers: the success path; refusal before start (no stop attempted); a partial enable/start; no PID;
# bind failure; non-200 status; identity mismatch. Each is contained with "unit inactive, no cpbridge process", except
# where a stop failure or a remaining process must report CONTAINMENT UNKNOWN.
# Usage: bash start_live.test.sh     exit 0 = every case behaved.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0; ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; sed 's/^/    /' "$T/out"; fails=$((fails+1)); }
SHA=$(printf 'e%.0s' {1..40}); PIN=$(printf 'p%.0s' {1..64}); JS=$(printf 'j%.0s' {1..64})

cat > "$T/systemctl" <<'EOF'
#!/bin/bash
S=$FAKE/state
case "$1" in
  is-active) cat "$S" 2>/dev/null || echo inactive;;
  enable) echo active > "$S"; touch "$FAKE/started"; [[ -e $FAKE/enable_fail ]] && exit 1; exit 0;;
  show) [[ -e $FAKE/nopid ]] && echo 0 || echo 4242;;
  stop) echo stop >> "$FAKE/calls"; [[ -e $FAKE/stop_fail ]] && exit 1; [[ -e $FAKE/stop_noop ]] || echo inactive > "$S"; exit 0;;
esac
EOF
cat > "$T/pgrep" <<'EOF'
#!/bin/bash
[[ -e $FAKE/proc_left && -e $FAKE/started ]] && exit 0; exit 1
EOF
cat > "$T/curl" <<'EOF'
#!/bin/bash
cat > /dev/null; printf '%s\n%s' "$(cat "$FAKE/body")" "$(cat "$FAKE/code")"
EOF
cat > "$T/bind" <<'EOF'
#!/bin/bash
exit $(cat "$FAKE/bind_rc")
EOF
cat > "$T/sleep" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$T"/{systemctl,pgrep,curl,bind,sleep}

case_() {   # <name> <want-rc: 0|1> <grep-pattern-that-must-appear> [setup files...]
  local name=$1 want=$2 pat=$3; shift 3
  local F="$T/c"; rm -rf "$F"; mkdir -p "$F/opt/$SHA" "$F/etc"
  ln -s "$F/opt/$SHA" "$F/opt/current"; echo "$JS  bridge.js" > "$F/opt/$SHA/MANIFEST.sha256"
  echo "$PIN" > "$F/etc/config.pinned.sha256"; echo 1000 > "$F/etc/swap.epoch"; echo forward > "$F/etc/swap.mode"; echo s3cr3t > "$F/etc/caller.secret"
  printf '{"a":1}\n{"b":2}\n' > "$F/ledger"
  echo 200 > "$F/code"; echo 0 > "$F/bind_rc"
  printf '{"halted":null,"routes":["gpt-6-luna@medium"],"identity":{"script_sha256":"%s","config_sha256":"%s"}}' "$JS" "$PIN" > "$F/body"
  for s in "$@"; do eval "$s"; done
  FAKE=$F OPTROOT=$F/opt ETC=$F/etc LEDGER=$F/ledger SYSTEMCTL=$T/systemctl PGREP=$T/pgrep CURL=$T/curl BIND=$T/bind SLEEP=$T/sleep \
    bash "$HERE/start_live.sh" "$SHA" > "$T/out" 2>&1; local rc=$?
  if { [[ $want == 0 && $rc == 0 ]] || [[ $want != 0 && $rc != 0 ]]; } && grep -q -- "$pat" "$T/out"; then ok "$name"; else bad "$name (rc=$rc)"; fi
}

case_ 'success: bound, status + identity through the real status_check.py' 0 'live on'
case_ 'refuse before start: not stopped -> no stop attempted' 1 'REFUSE: the bridge is not stopped' 'echo active > $F/state'
grep -q stop "$T/c/calls" 2>/dev/null && { echo "FAIL refuse-before-start called stop"; fails=$((fails+1)); }
case_ 'partial enable/start is contained' 1 'contained: unit inactive, no cpbridge process' 'touch $F/enable_fail'
case_ 'no main PID is contained' 1 'STOP: no main PID' 'touch $F/nopid'
case_ 'bind failure is contained' 1 'contained: unit inactive' 'echo 1 > $F/bind_rc'
case_ 'status 503 is contained' 1 'STOP: status=503' 'echo 503 > $F/code'
case_ 'identity mismatch is contained' 1 'STOP: status or startup identity does not bind' "sed -i 's/$JS/$(printf 'x%.0s' {1..64})/' \$F/body"
case_ 'halted latch in status is contained' 1 'STOP: status or startup identity does not bind' "sed -i 's/\"halted\":null/\"halted\":{\"code\":\"x\"}/' \$F/body"
case_ 'stop failure: CONTAINMENT UNKNOWN' 1 'CONTAINMENT UNKNOWN: systemctl stop failed' 'echo 1 > $F/bind_rc' 'touch $F/stop_fail'
case_ 'unit still active after stop: CONTAINMENT UNKNOWN' 1 'CONTAINMENT UNKNOWN: unit not inactive' 'echo 1 > $F/bind_rc' 'touch $F/stop_noop'
case_ 'process remains after stop: CONTAINMENT UNKNOWN' 1 'CONTAINMENT UNKNOWN: a cpbridge process remains' 'echo 1 > $F/bind_rc' 'touch $F/proc_left'
grep -q '{"b":2}' "$T/out" && { echo "FAIL old ledger rows printed as 'since start'"; fails=$((fails+1)); } || echo "PASS only rows written since start are printed"

echo "$fails failure(s)"; exit $(( fails > 0 ))
