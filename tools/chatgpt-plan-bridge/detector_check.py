"""Run a pinned redactor module as a DETECTOR over stdin (design §4). The module is loaded byte-identical (hash checked);
its import-time os.makedirs side effect is suppressed so it runs inside a sandbox with no access to its home paths.
Output: {"hit": bool, "rules": [rule indexes that fired]}. Exit 2 on any error (the bridge treats that as a scanner failure)."""
import hashlib, importlib.util, json, os, sys

path, want = sys.argv[1], sys.argv[2]
try:
    if hashlib.sha256(open(path, 'rb').read()).hexdigest() != want:
        raise SystemExit(2)
    real = os.makedirs
    os.makedirs = lambda *a, **k: None
    try:
        spec = importlib.util.spec_from_file_location('pinned_redactor', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        os.makedirs = real
    text = sys.stdin.read()
    rules = [i for i, (rx, rep) in enumerate(mod._REDACT_RULES) if rx.sub(rep, text) != text]
    print(json.dumps({'hit': bool(rules), 'rules': rules}))
except SystemExit:
    raise
except Exception:
    raise SystemExit(2)
