#!/usr/bin/env bash
# Root-owned stable lock inode; a pending marker survives crashes/unknown teardown.
stage_revoke_evidence() {
  install -m 0600 -o "$3" -g "$4" -- "$1" "$2"
}
acquire_owner() {
  local lock=$1 pending=$2
  exec 9>"$lock"
  flock -n 9 || { printf 'HOLD: launcher already owns the evaluation UID\n' >&2; return 1; }
  [[ ! -e $pending ]] || { printf 'HOLD: prior launcher needs reconciliation\n' >&2; return 1; }
}
uid_empty() {
  local rc
  if pgrep -u "$1" >/dev/null; then return 1; else rc=$?; fi
  [[ $rc == 1 ]]
}
stop_confirmed() {
  local unit=$1 uid=$2 report key value load= state= main= control=
  # A collected unit may reject stop; only affirmative readback plus UID census permits removal.
  systemctl stop "$unit.service" >/dev/null 2>&1 || :
  report=$(systemctl show "$unit.service" -p LoadState -p ActiveState -p MainPID -p ControlPID) || return 1
  while IFS='=' read -r key value; do
    case $key in LoadState) load=$value;; ActiveState) state=$value;; MainPID) main=$value;; ControlPID) control=$value;; esac
  done <<< "$report"
  [[ $load == loaded || $load == not-found ]] && [[ $state == inactive || $state == failed ]] && [[ $main == 0 && $control == 0 ]] || return 1
  uid_empty "$uid"
}
