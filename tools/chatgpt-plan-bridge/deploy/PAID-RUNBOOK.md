# Paid (API-key) mode: attended delivery runbook

GBRAIN-S593. One operator, root on the bridge host, every step run by hand in order and its full output kept. `NEW` is the
reviewed head of this worktree (`W`); `OLD` / `OLDW` are the head and clean worktree of the bundle installed today.
Nothing here is automatic: each step ends in a state that is safe to stop in, and the bridge is STOPPED from step 2 until
step 5. No step clears a halt latch, resets a counter or retries a call.

## States

`plan-installed` → (step 2) `paid-installed, stopped` → (step 3) `canary judged, stopped` → (step 4) `receipt accepted`
→ (step 5) `paid-live`. Any refusal or STOP leaves the bridge stopped where it is; step R returns to `plan-installed, stopped`.

## 0. Baseline (read-only)

```
E=/etc/chatgpt-plan-bridge; S=/srv/chatgpt-plan-bridge/state
readlink /opt/chatgpt-plan-bridge/current                 # must be /opt/chatgpt-plan-bridge/$OLD
ls -la $S; cat $S/counters.json; ls $S/halted.json         # a present halted.json STOPS here: its reason gets its own recorded disposition
python3 -I $OLDW/tools/chatgpt-plan-bridge/deploy/verify_install.py $OLDW > $E/verify-baseline.pre-paid 2>&1; cat $E/verify-baseline.pre-paid
```

The baseline verifier output is the rollback reference. On this host it is expected to stop at `config.json` (the live plan
config carries two recorded hand edits: a `halt_on` list and detector paths); that exact output is what rollback must reproduce.
Hourly/daily call counters are taken as they are. If they would refuse a call, the canary waits; they are not reset.

## 1. Offline checks (no service touched)

```
bun test tools/chatgpt-plan-bridge/                                        # from $W
tools/chatgpt-plan-bridge/deploy/paid_delivery.test.sh $OLDW
```

## 2. Install paid, stopped

```
tools/chatgpt-plan-bridge/deploy/install.sh $W $NEW paid
```

It refuses on a halt latch; disables and stops the unit and proves no bridge process runs; saves the plan config and the
`current` target as rollback preimages (once); installs the bundle; writes the key from the local vault to
`/etc/chatgpt-plan-bridge/openai-api.key` (root:cpbridge 0640; an existing different key refuses); writes the paid config;
runs `init_spend.py` as the bridge user; installs the units without starting them; runs `verify_install.py $W paid`.
End state: stopped and disabled. The sign-in directory is untouched.

## 3. The one paid canary

```
mkdir -m 0700 <evidence-dir>; tools/chatgpt-plan-bridge/deploy/paid-canary.sh $W $NEW <evidence-dir>
```

One request through the installed bundle, run as `cpbridge` in a transient unit with the service's own sandbox properties,
on port 18796 with a config equal to the installed one except the port, behind the same per-uid egress fence. Maximum kept
by this call: one reservation, 274,500 micro-dollars, added to whatever the day already holds.

PASS needs all of: HTTP 200; finish `stop` with a non-empty answer; exactly one new ledger row, bound to the response's
request id; that row `status 200`, `settled true`, integer usage inside the route maxima, `settled_micro` equal to the cost
recomputed from usage; no halt latch; `spend[admission day] == before + settled_micro` and no other day changed.
The service tier is not observed directly: the bridge settles only after seeing tier `default`, so `settled true` is the
evidence, and the receipt says so. Every other outcome is STOP: no second call, the reservation and any latch stay as they are.
The script refuses to run twice; a second canary needs a new reviewed decision.

What this does and does not show about sign-in traffic: the running bytes are the reviewed paid bundle (step 2 verifier),
whose paid branch never constructs the sign-in store, and the egress chain listing at the end of the run is kept. The fence
allows the API host and the sign-in host through the same address sets, so the listing is not proof that no packet went to
the sign-in host.

## 4. Receipt acceptance

Post `<evidence-dir>/receipt.json` (it holds no secret) to the reviewer. The bridge stays stopped until the receipt is accepted.

## 5. Start paid-live (only after step 4)

```
systemctl enable --now chatgpt-plan-bridge.service chatgpt-plan-bridge-egress.timer
systemctl is-active chatgpt-plan-bridge.service
printf 'header = "Authorization: Bearer %s"\n' "$(< /etc/chatgpt-plan-bridge/caller.secret)" | curl -sS -K - http://127.0.0.1:18795/v1/bridge/status
python3 -I $W/tools/chatgpt-plan-bridge/deploy/verify_install.py $W paid
```

Expect `active`, status 200 with `"halted":null`, verifier VERIFIED. Then watch the first live rows in `requests.jsonl`
(`settled true`) and `counters.json` `spend`.

## R. Rollback (from any state after step 2)

```
tools/chatgpt-plan-bridge/deploy/rollback-paid.sh $OLDW $OLD
```

Restores the saved plan config bytes, the previous bundle link and the previous units; leaves the key file and the spend
map in place (the previous bundle keeps a spend map it does not know: `paid_delivery.test.sh`); clears nothing; ends
STOPPED and disabled. The plan service is started by hand only when its own prerequisites hold.

## Stop conditions (all steps)

A refusal from any script; a verifier mismatch; a halt latch; a bridge process that survives a stop; any canary outcome
other than PASS. In each case: stop, keep the output, report. Never clear `halted.json`, edit `counters.json` or re-run the
canary to get past one.
