# Luna stage 2 — attended runbook (STAGE2-DESIGN r3)

**How this runs:** one step per message, full unfiltered output, under ONE Nazz terminal GO that binds:
- the reviewed head `<HEAD>`;
- `run.manifest` sha256 `<RUNSHA>`.

The steps use only reviewed code:
- `canary.sh`, including stage 2's `CANARY_MANIFEST` E;
- `date_parts.py`, `inventory.ts`, `date_gates.py`, `state_check.sh`;
- the reviewed converter.

**STOP rule:** any step with an exit status ≠ 0, or an output that differs from what is written here, is a STOP.
- On a STOP: run `state_check.sh post-run` and "Close by hand" below if needed, then report to Nazz and Pebble.
- Nothing is retried or rolled back without a decision.
- A rollback stops the run. Its parts stay excluded.

**Variables:**
```
W=/root/work/gbrain-s552-luna-bridge   HEAD=<HEAD>   RUN=/root/work/dream-s552-luna/stage2-run
C=$W/tools/chatgpt-plan-bridge/deploy  O=$W/tools/chatgpt-plan-bridge/ops   CORPUS=/root/.claude/projects/-root/session-text
```
DB access in every step:
- `source /root/.gbrain/pg.env`;
- `export DATABASE_URL=postgres://gbrain:$PASS@127.0.0.1:5432/gbrain_pingu`, environment only and never on argv.

## 0. Before the GO (read-only; goes into the packet)
1. `git -C $W rev-parse HEAD` must equal `<HEAD>`; `git -C $W status --porcelain` must be empty.
2. Inventory: `bun $O/inventory.ts $CORPUS $RUN/freeze-inventory $RUN/renames.tsv > $RUN/freeze-inventory.out`.
   - The classes must sum to `discovered`.
   - The independent live-path count must equal extracted + changed.
3. Eligible list: `python3 -I -c` prints the `missing` rows (`hash16\tpath`) from `freeze-inventory/inventory.json` into `$RUN/eligible.manifest`.
4. Plan: `python3 -I $O/date_parts.py plan $RUN/eligible.manifest $RUN/run.manifest $RUN/refused.tsv`.
   - `chmod 0444 $RUN/run.manifest $RUN/run.manifest.sessions`.
   - `sha256sum $RUN/run.manifest` gives `<RUNSHA>`. `run.manifest.sessions` is the freeze baseline of every planned session's jsonl (size, mtime); its sha256 goes in the packet too.
   - Batch count = ceil(rows / 100).

## 1. Once, after the GO
1. Converter:
   - `sha256sum /root/.gbrain/ingest-session-transcript.py` must equal `425615c099e23da64053e1b2d700d252dc52ee193fc45381dfb3bc161aa6ee2d`.
   - `cp -p` it to `$RUN/converter.base.py`.
   - `install -m 0755 $W/tools/chatgpt-plan-bridge/ingest/ingest-session-transcript.py /root/.gbrain/ingest-session-transcript.py.tmp && mv /root/.gbrain/ingest-session-transcript.py.tmp /root/.gbrain/ingest-session-transcript.py`.
   - Read back: its sha256 must equal the reviewed file's sha256.
2. `sha256sum $RUN/run.manifest` must still equal `<RUNSHA>`.

## 2. Per batch NN (rows (NN−1)·100+1 … NN·100 of run.manifest), strictly in order
1. **Slice:** `sed -n "${a},${b}p" $RUN/run.manifest > $RUN/batch-NN.members`.
   - **Session growth (§3a, drop-only):** `python3 -I $O/date_parts.py sessions-check $RUN/batch-NN.members $RUN/run.manifest.sessions`.
     - Exit 0: continue.
     - Exit 1: every listed row's session resumed after the freeze. Move those rows to `$RUN/batch-NN.dropped` (reason `session-grew`) and re-run the check.
     - Exit 2: STOP.
2. **Rename:** `python3 -I $O/date_parts.py rename $RUN/batch-NN.members 1 <k> $RUN/renames.tsv --apply`.
   - It prints one line per row: `renamed`, `skip (already dated)` or `skip (already renamed)`.
   - A row that STOPs (bytes changed, or legacy file missing) is **dropped**:
     - move it to `$RUN/batch-NN.dropped` with its reason;
     - re-run steps 1–2 on the remaining rows.
3. **Batch manifest:** `awk -F'\t' '{print $1"\t"$4}' $RUN/batch-NN.members > $RUN/batch-NN.manifest`.
4. `bash $C/canary.sh V $HEAD`, then `bash $C/canary.sh B $HEAD`: installed bridge verified, then one real call `200:stop`.
5. `bash $C/canary.sh C $HEAD`, then `bash $C/canary.sh D $HEAD`: runners paused; config set, with admission CLOSED before the corpus key.
6. `CANARY_MANIFEST=$RUN/batch-NN.manifest CANARY_RENAMES=$RUN/renames.tsv bash $C/canary.sh E $HEAD`.
   - Taken whole, or refused whole.
   - A refusal that names pairs (no longer MISSING, bytes changed, previously exposed) drops exactly those pairs (step 2 rule), and E is re-run.
   - Any other refusal is a STOP.
7. `bash $C/canary.sh F $HEAD`: preflight must be `CLEAN`.
8. **`bash $C/state_check.sh pre-open`**: must print `STATE pre-open: OK`.
   - Then **`python3 -I $O/date_parts.py sessions-check $RUN/batch-NN.members $RUN/run.manifest.sessions`** must exit 0, immediately before G.
   - Any member whose session grew since step 1 is a STOP **before OPEN**: no admission is opened, and the decision follows.
9. `bash $C/canary.sh G $HEAD`. Whatever its exit status:
   - **`bash $C/state_check.sh post-run`**: admission closed, runners still stopped, no runner process, 0 live locks, bridge latch clear.
   - G rc ≠ 0, or post-run ≠ OK: STOP (unknown outcome). Run "Close by hand" if admission or the corpus key is open. **No rollback without a decision.**
10. `bash $C/canary.sh H $HEAD`. The PASS criteria it prints must all hold:
    - 0 atoms without provenance;
    - 0 owner keys with several live generations;
    - every bridge row since T_start `200:stop`;
    - served `gpt-6-luna`.
11. **`python3 -I $O/date_gates.py <attempt> $RUN/batch-NN.members`** must print `GATES: PASS` (exit 0).
    - Exit 10 (a gate failed on complete evidence) is a STOP. Report and decide; rollback is the expected decision.
    - Exit 2 (evidence missing or unreadable) is a STOP and never a rollback by itself.
12. `bash $C/canary.sh I $HEAD`, then `bash $C/canary.sh K $HEAD`: the kit covers every atom.
13. **Blind rating** (the stage-1 procedure, unchanged): R1, an isolated Opus rater, and R2, Pebble, label the kit. Neither sees the other's file.
14. `bash $C/canary.sh S $HEAD`:
    - PASS (both raters ≥ 0.80 on both metrics) → step 15;
    - FAIL → STOP; rollback on decision;
    - not scored → STOP.
15. `bash $C/canary.sh resume $HEAD`, then **`bash $C/state_check.sh post-resume`**: admission closed, corpus key absent in DB and file, autopilot active.
16. Report the batch to Nazz in one line: atoms, gates, rating, and running totals.

## 3. Rollback (only on a decision)
1. `bash $C/canary.sh rollback $HEAD`: its verify must be `DONE`.
2. **`bash $C/state_check.sh post-rollback`**.
3. The run ends there. Report; nothing further runs under this GO.

## 4. Close by hand (when state_check shows admission open or the corpus key present after a STOP)
```
cd $W && bun src/cli.ts config set cycle.extract_atoms.admit_hashes_file /root/work/dream-s552-luna/canary/closed.manifest
cd $W && bun src/cli.ts config unset dream.synthesize.session_corpus_dir
bash $C/state_check.sh post-run      # admission must read closed; then confirm the corpus key: db=0, file=0
```
Runners stay stopped until a decision.

## 5. End of run (after the last batch's step 15)
1. Final read-only inventory: step 0.2 into `$RUN/end-inventory`.
2. Report to Nazz and Pebble: batches kept, atoms, dropped and refused counts.

The dream timer restore is out of scope; it is its own packet.
