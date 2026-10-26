# retry_plan.retry_outcome on the REAL producer's output (Pebble HOLD 22:37Z #1; rehearsal 8 caught a stub-shaped check):
# positive controls = the two real stage-2 G outcomes (read-only copies), negatives = unknown outcomes that must raise.
# Usage: python3 -I -B test_retry_plan.py <batch-01 run.json> <batch-02 run.json>
import copy, importlib.util, json, os, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('rp', os.path.join(HERE, 'retry_plan.py')); rp = importlib.util.module_from_spec(spec); spec.loader.exec_module(rp)
b1, b2 = (json.load(open(p)) for p in sys.argv[1:3])
n = 0
def write(t, obj):
    p = os.path.join(t, 'o.json'); open(p, 'w').write(obj if isinstance(obj, str) else json.dumps(obj)); return p
def ok(t, obj, paths, want_fail):
    global n; got = rp.retry_outcome(write(t, obj), paths); assert len(got) == want_fail, got; n += 1
def unknown(t, obj, paths, why):
    global n
    try: rp.retry_outcome(write(t, obj), paths)
    except ValueError as e: assert why in str(e), (why, str(e)); n += 1; return
    raise AssertionError(f'accepted an unknown outcome ({why})')
with tempfile.TemporaryDirectory() as t:
    assert b1['schema_version'] == '1' and b2['schema_version'] == '1'   # the producer's real type
    d2 = b2['phases'][0]['details']; fsrc = d2['failures'][0]['source']
    adm2 = {fsrc} | {f'/x/p{i}' for i in range(d2['transcripts_processed'])}
    ok(t, b1, {f'/x/q{i}' for i in range(100)}, 0)                      # real batch 01: 100 processed + 0 failures
    ok(t, b2, adm2, 1)                                                  # real batch 02: 99 processed + 1 malformed
    unknown(t, '', adm2, 'Expecting value')                             # zero-byte
    unknown(t, '{"atoms":', adm2, '')                                   # truncated JSON
    unknown(t, dict(b2, schema_version=1), adm2, 'schema 1')            # wrong schema type
    unknown(t, dict(b2, phases=b2['phases'] * 2), adm2, 'schema 1')     # two phases
    unknown(t, b2, {fsrc}, 'accounts for 99+1 of 1')                    # incomplete accounting
    unknown(t, b2, adm2 - {fsrc} | {'/x/extra'}, 'outside retry.manifest')   # failure from a foreign source
    for k, v in (('partial', True), ('dry_run', True), ('budget_exhausted', True), ('write_pending', 1), ('held_failed', 1), ('stopped_outputs', 1)):
        x = copy.deepcopy(b2); x['phases'][0]['details'][k] = v; unknown(t, x, adm2, 'not final')
    x = copy.deepcopy(b2); del x['phases'][0]['details']['transcripts_processed']; unknown(t, x, adm2, 'complete counters')
print(f'retry_outcome self-test: {n} checks passed (2 real outcomes accepted, {n - 2} unknown outcomes refused)')
