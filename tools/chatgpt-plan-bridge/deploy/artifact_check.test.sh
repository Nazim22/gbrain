#!/bin/bash
# S603 negative control for artifact_check.ts: the HEAD bundle passes; a sabotaged bundle (mask result ignored, rescan
# refusal removed, so unmasked text is sent) fails; the pre-S603 5a897cd1 bundle (no S590, no exports) fails.
# Importing an old bundle runs its main(); its argv[2] is then the bundle path, which is not JSON, so it throws before
# binding anything (no server starts).
# Usage: bash artifact_check.test.sh [old-bundle.js]     exit 0 = all three behaved.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); TOOL=$(dirname "$HERE"); W=$(cd "$TOOL/../.." && pwd)
OLD=${1:-/opt/chatgpt-plan-bridge/5a897cd194e1b19773b12ff6b54d45f02ba0ce6b/bridge.js}
BUN=${BUN:-/root/.bun/bin/bun}
T=$(mktemp -d); SAB="$W/tools/chatgpt-plan-bridge-sabotage-$$"; trap 'rm -rf "$T" "$SAB"' EXIT
fails=0
mkdir -p "$T/detectors"; cp "$TOOL/detector_check.py" "$T/detectors/"
cp /root/work/dream-s552-vault-atoms/pilot/detector/ingest-session-transcript.py "$T/detectors/redactor.py"
python3 -I - "$T" > "$T/config.json" <<'PY'
import json, sys
b = sys.argv[1]
print(json.dumps({"port": 0, "state_dir": "", "auth_dir": "", "routes": {"gpt-6-luna@medium": {"model": "gpt-6-luna", "effort": "medium", "max_output_chars": 64000}},
  "ceilings": {"per_hour": 600, "per_day": 6000, "concurrency": 2}, "max_body_bytes": 262144, "upstream": {"connect_ms": 10000, "request_ms": 300000},
  "halt_on": ["leak_gate_unavailable"], "leak": {"python": "/usr/bin/python3", "detector_check": f"{b}/detectors/detector_check.py",
  "redactor": f"{b}/detectors/redactor.py", "redactor_sha256": "425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d",
  "gitleaks": "/usr/local/bin/gitleaks", "tmp_dir": "", "timeout_ms": 20000}}))
PY
run() { "$BUN" "$HERE/artifact_check.ts" "$1" "$T/config.json" > "$T/out.txt" 2>&1; }

(cd "$W" && "$BUN" build tools/chatgpt-plan-bridge/main.ts --target=bun --outfile "$T/head.js" >/dev/null)
if run "$T/head.js"; then echo "PASS HEAD bundle passes"; else echo "FAIL HEAD bundle"; cat "$T/out.txt"; fails=$((fails+1)); fi

cp -r "$TOOL" "$SAB"
python3 -I - "$SAB/bridge.ts" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s, n1 = re.subn(r"\n( *)chat = \{ \.\.\.parsed, instructions: m\.parts\[0\] \+ MASK_NOTE.*\n", r"\n\1chat = parsed;   // SABOTAGE: mask result ignored\n", s)
s, n2 = re.subn(r"\n *if \(!again\.clean\) return refuse\(again\.detector, again\.rules, 'rescan'\);\n", "\n", s)
assert n1 == 1 and n2 == 1, (n1, n2); open(p, 'w').write(s)
PY
(cd "$W" && "$BUN" build "tools/chatgpt-plan-bridge-sabotage-$$/main.ts" --target=bun --outfile "$T/sab.js" >/dev/null)
if run "$T/sab.js"; then echo "FAIL sabotaged bundle passed"; cat "$T/out.txt"; fails=$((fails+1));
elif grep -q '^FAIL (a) sent body carries no sentinel' "$T/out.txt"; then echo "PASS sabotaged bundle fails on (a): the sentinel reached the sent body";
else echo "FAIL sabotaged bundle failed for another reason"; cat "$T/out.txt"; fails=$((fails+1)); fi

if [[ -f $OLD ]]; then
  if run "$OLD"; then echo "FAIL old bundle passed"; fails=$((fails+1)); else echo "PASS old bundle ($(basename "$(dirname "$OLD")" | cut -c1-8)) fails: $(head -1 "$T/out.txt")"; fi
else echo "FAIL old bundle $OLD not found"; fails=$((fails+1)); fi

echo "$fails failure(s)"; exit $(( fails > 0 ))
