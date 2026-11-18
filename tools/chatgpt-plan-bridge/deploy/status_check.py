"""S603: judge /v1/bridge/status JSON (stdin) for start_live.sh.
Usage: status_check.py <forward|rollback> <bundle-dir> <pinned-config-sha256> < status.json     exit 0 = binds."""
import json, sys

mode, b, pin = sys.argv[1:4]
d = json.load(sys.stdin)
assert d.get('halted') is None, f"halted: {d.get('halted')}"
if mode == 'forward':
    i = d.get('identity') or {}
    m = {}
    for line in open(f'{b}/MANIFEST.sha256').read().splitlines():
        if line.strip():
            h, name = line.split(None, 1)
            m[name] = h
    assert i.get('script_sha256') == m['bridge.js'], 'script_sha256 differs from the manifest'
    assert i.get('config_sha256') == pin, 'config_sha256 differs from the pinned config'
    print('identity bound:', i['script_sha256'][:16], i['config_sha256'][:16])
print('status 200, halted null, routes', d.get('routes'))
