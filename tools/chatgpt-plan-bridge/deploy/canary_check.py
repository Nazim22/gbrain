"""Judge the ONE paid canary call (GBRAIN-S593, PAID-RUNBOOK.md step 3). Reads only files; makes no call. PASS needs ALL of:
- HTTP 200, finish_reason "stop", non-empty answer;
- exactly ONE new ledger row since the pre-snapshot, and it is the row of the response's request id;
- that row: status 200, settled true, integer usage inside the route maxima, settled_micro == the cost recomputed from usage;
- no halt latch; counters valid;
- spend[row.spend_day] == pre.spend.get(day, 0) + settled_micro, every other spend entry unchanged (UTC ADMISSION day).
The service tier is NOT observed directly: the bridge settles only after it has seen tier "default" (bridge.ts), so
settled:true is the evidence, recorded here as an inference. Any other outcome is STOP: no retry, nothing cleared.
Usage: canary_check.py <config.json> <pre-counters.json> <pre-ledger-lines> <http-code> <response.json> <request-id> <receipt-out.json>"""
import json, os, sys

def micro(v): return type(v) is int and 0 <= v <= 2**53 - 1
def day_ok(k):
    import datetime, re
    if type(k) is not str or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', k): return False
    try: datetime.date.fromisoformat(k); return True
    except ValueError: return False
def counters_ok(c):
    return (type(c) is dict and all(micro(c.get(k)) for k in ('hour_start', 'hour', 'day_start', 'day'))
            and type(c.get('spend')) is dict and all(day_ok(k) and micro(v) for k, v in c['spend'].items()))
def load(path, why, what):
    try: return json.load(open(path))
    except Exception as e: why.append(f'{what} unreadable ({type(e).__name__})'); return None

def main(cfg_p, pre_p, pre_lines, code, resp_p, req_id, out_p):
    why = []
    def need(ok, msg):
        if not ok: why.append(msg)
    receipt = {'verdict': 'STOP', 'reasons': why, 'request_id': req_id, 'http': code,
               'service_tier': 'not observed directly; inferred "default" from settled:true (the bridge settles only after seeing it)'}
    try:
        cfg = json.load(open(cfg_p)); state = cfg['state_dir']; route = next(iter(cfg['routes'].values()))
        pre = load(pre_p, why, 'pre-counters'); post = load(f'{state}/counters.json', why, 'post-counters')
        need(pre is not None and counters_ok(pre), 'pre-counters are not valid counters with a spend map')
        need(post is not None and counters_ok(post), 'post-counters are not valid counters with a spend map')
        rows = []
        try: rows = [json.loads(l) for l in open(f'{state}/requests.jsonl', 'rb').read().splitlines()[int(pre_lines):]]
        except Exception as e: need(False, f'ledger unreadable ({type(e).__name__})')
        need(code == '200', f'HTTP {code}')
        resp = load(resp_p, why, 'response') or {}
        ch = (resp.get('choices') or [{}])[0] if type(resp) is dict else {}
        need(ch.get('finish_reason') == 'stop', f"finish_reason {ch.get('finish_reason')}")
        need(bool(((ch.get('message') or {}).get('content') or '').strip()), 'empty answer')
        need(len(rows) == 1, f'{len(rows)} new ledger rows, want exactly 1')
        row = rows[0] if len(rows) == 1 and type(rows[0]) is dict else {}
        need(bool(req_id) and row.get('id') == req_id, 'the new ledger row is not the response request id')
        need(row.get('status') == 200 and row.get('settled') is True, f"row status {row.get('status')} settled {row.get('settled')} ({row.get('unsettled') or row.get('code')})")
        u = row.get('usage') if type(row.get('usage')) is dict else {}; i, o = u.get('input_tokens'), u.get('output_tokens')
        ints = type(i) is int and type(o) is int and 0 <= i <= route['max_input_tokens'] and 0 <= o <= route['max_output_tokens']
        need(ints, 'usage missing or outside the route maxima')
        up = lambda t, p: -(-t * p // 1_000_000)
        cost = up(i, route['price_micro_per_mtok']['input']) + up(o, route['price_micro_per_mtok']['output']) if ints else None
        need(cost is not None and row.get('settled_micro') == cost, f"settled_micro {row.get('settled_micro')} != recomputed {cost}")
        need(not os.path.lexists(f'{state}/halted.json'), 'a halt latch exists')
        day = row.get('spend_day')
        need(day_ok(day), f'the row has no valid UTC admission day ({day!r})')
        # The arithmetic is unconditional: any missing piece above already failed, and a missing piece here fails too.
        ps = pre.get('spend') if type(pre) is dict and type(pre.get('spend')) is dict else None
        qs = post.get('spend') if type(post) is dict and type(post.get('spend')) is dict else None
        if ps is None or qs is None or cost is None or not day_ok(day): need(False, 'spend arithmetic could not be evaluated')
        else:
            need(qs.get(day) == ps.get(day, 0) + cost, f'spend[{day}] {qs.get(day)} != {ps.get(day, 0)} + {cost}')
            need({k: v for k, v in qs.items() if k != day} == {k: v for k, v in ps.items() if k != day}, 'another day in the spend map changed')
        receipt.update({'row': {k: row.get(k) for k in ('ts', 'id', 'status', 'finish', 'served', 'usage', 'reserved_micro', 'spend_day', 'settled', 'settled_micro', 'unsettled', 'code', 'latency_ms')},
                        'spend_before': ps, 'spend_after': qs, 'recomputed_micro': cost})
    except Exception as e:   # a judge that cannot finish is a STOP with a receipt, never a missing receipt
        why.append(f'judge error: {type(e).__name__}')
    receipt['verdict'] = 'PASS' if not why else 'STOP'
    json.dump(receipt, open(out_p, 'w'), indent=1)
    print(json.dumps(receipt, indent=1))
    sys.exit(0 if not why else 1)

if __name__ == '__main__':
    if len(sys.argv) != 8: print(__doc__); sys.exit(2)
    main(*sys.argv[1:])
