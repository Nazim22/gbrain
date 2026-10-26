#!/usr/bin/env python3
"""Luna stage 2 (STAGE2-DESIGN r2 18a291d1 §1, §3a): date MISSING transcript parts and rename them for one batch.

  date_parts.py plan <eligible.manifest> <run.manifest> <refused.tsv>
      eligible.manifest: "<hash16>\\t<legacy path>" rows (the §2 inventory's `missing` class).
      Writes run.manifest rows "<hash16>\\t<sha256>\\t<legacy path>\\t<dated path>\\t<date>", sorted by dated path,
      and refused.tsv rows "<hash16>\\t<legacy path>\\t<reason>". Reads only.
  date_parts.py rename <run.manifest> <first-row> <last-row> <renames.tsv> [--apply]
      Renames rows first..last (1-based, inclusive) legacy -> dated. Dry run unless --apply. Per row: the legacy file's
      sha256 must equal the manifest's, the dated path must not exist, and after the rename the dated file's sha256 must
      equal it again; each done rename is appended to renames.tsv. A row already renamed (dated present with the manifest
      sha256, legacy absent, recorded in renames.tsv) is skipped. Any other state stops the run with nothing further renamed.

Source date (§1): the UTC date of the part's first complete turn, found by a unique anchor (the turn's text up to the
next turn boundary, 40..200 chars) among the session jsonl's turns, raw or redacted. Every matching turn must carry a
valid zoned ISO timestamp and all must give one UTC date. Anything else is refused. No date is ever inferred.
"""
import datetime, glob, hashlib, importlib.util, os, re, sys, time

CONVERTER = "/root/.gbrain/ingest-session-transcript.py"
SRC_DIR = "/root/.claude/projects/-root"
ANCH_MAX, ANCH_MIN, ACTIVE_S = 200, 40, 20 * 60
TURN_SEP = re.compile(r"\n\n(User|Assistant): ")
NAME = re.compile(r"^session-([0-9a-f-]{36})((?:\.part\d+)?)\.txt$")

def load_converter():
    spec = importlib.util.spec_from_file_location("conv", CONVERTER)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()

def utc_date(ts):
    try: t = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError: return None
    return t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d") if t.tzinfo else None

def session_turns(conv, sid):
    """(raw, redacted, timestamp) per turn, with the converter's own filters and redaction."""
    out = []
    for line in open(f"{SRC_DIR}/{sid}.jsonl", errors="replace"):
        try: o = conv.json.loads(line)
        except Exception: continue
        msg = o.get("message") if isinstance(o.get("message"), dict) else o
        role = msg.get("role") or o.get("type")
        if role not in ("user", "assistant"): continue
        txt = conv.clean_text(msg.get("content"))
        m = conv.CHANNEL_RE.search(txt or "")
        if m: txt = "Discord message from " + m.group(1) + ": " + m.group(2).strip()
        if not txt or txt.strip().startswith(("<", "[gbrain-", "[mnemo-")): continue
        txt = re.sub(r"<system-reminder>.*?</system-reminder>", "", txt, flags=re.S).strip()
        if len(txt) < 15: continue
        out.append((("User" if role == "user" else "Assistant") + ": " + txt, o.get("timestamp")))
    known = set().union(*(conv.secret_values(t) for t, _ in out)) if out else set()
    return [(t, conv.redact_text(t, known), ts) for t, ts in out]

def part_date(conv, path, cache):
    """(date, None) or (None, refusal reason)."""
    sid = NAME.match(os.path.basename(path)).group(1)
    if not os.path.exists(f"{SRC_DIR}/{sid}.jsonl"): return None, "no-jsonl"
    if sid not in cache: cache[sid] = session_turns(conv, sid)
    text = open(path, errors="replace", newline="").read()
    body = text.split("\n\n", 1)[1] if "\n\n" in text else ""
    if re.match(r"(User|Assistant): ", body): first = body
    else:
        k = TURN_SEP.search(body)
        if not k: return None, "no-complete-turn"
        first = body[k.start() + 2:]
    nxt = TURN_SEP.search(first[1:])
    anchor = first[:min(ANCH_MAX, nxt.start() + 1 if nxt else ANCH_MAX)]
    if len(anchor) < ANCH_MIN: return None, "short-anchor"
    hits = [ts for raw, red, ts in cache[sid] if raw.startswith(anchor) or red.startswith(anchor)]
    if not hits: return None, "no-match"
    dates = [utc_date(ts) for ts in hits]
    if None in dates: return None, "bad-timestamp"
    if len(set(dates)) > 1: return None, "ambiguous-date"
    return dates[0], None

def plan(eligible, run_manifest, refused_tsv):
    conv, cache, rows, refused = load_converter(), {}, [], []
    for line in open(eligible):
        h, p = line.rstrip("\n").split("\t")
        m = NAME.match(os.path.basename(p))
        if not m: refused.append((h, p, "not-a-legacy-part-name")); continue
        sid, suffix = m.groups()
        if not suffix and os.path.exists(os.path.join(os.path.dirname(p), f"session-{sid}.part1.txt")):
            refused.append((h, p, "stale-single")); continue
        j = f"{SRC_DIR}/{sid}.jsonl"
        if os.path.exists(j) and time.time() - os.path.getmtime(j) < ACTIVE_S: refused.append((h, p, "active-session")); continue
        day, why = part_date(conv, p, cache)
        if why: refused.append((h, p, why)); continue
        dated = os.path.join(os.path.dirname(p), f"{day}-{os.path.basename(p)}")
        rows.append((h, sha256(p), p, dated, day))
    rows.sort(key=lambda r: r[3])
    with open(run_manifest, "w") as f:
        for r in rows: f.write("\t".join(r) + "\n")
    with open(refused_tsv, "w") as f:
        for r in refused: f.write("\t".join(r) + "\n")
    print(f"plan: {len(rows)} dated, {len(refused)} refused, of {len(rows) + len(refused)} eligible rows")

def rename(run_manifest, first, last, renames_tsv, apply):
    rows = [l.rstrip("\n").split("\t") for l in open(run_manifest)][first - 1:last]
    done = {l.split("\t")[1] for l in open(renames_tsv)} if os.path.exists(renames_tsv) else set()
    for n, (h, sha, legacy, dated, day) in enumerate(rows, first):
        if dated in done and not os.path.exists(legacy) and os.path.exists(dated) and sha256(dated) == sha:
            print(f"{n} skip (already renamed) {os.path.basename(dated)}"); continue
        if not os.path.exists(legacy): sys.exit(f"{n} STOP: legacy missing {legacy}")
        if os.path.exists(dated): sys.exit(f"{n} STOP: destination exists {dated}")
        if sha256(legacy) != sha: sys.exit(f"{n} STOP: bytes changed since the run freeze {legacy}")
        if not apply: print(f"{n} would rename {os.path.basename(legacy)} -> {os.path.basename(dated)}"); continue
        os.rename(legacy, dated)
        if sha256(dated) != sha: sys.exit(f"{n} STOP: sha256 differs after rename {dated}")
        with open(renames_tsv, "a") as f: f.write("\t".join((legacy, dated, sha, h, day)) + "\n")
        print(f"{n} renamed {os.path.basename(legacy)} -> {os.path.basename(dated)}")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["plan"] and len(a) == 4: plan(*a[1:])
    elif a[:1] == ["rename"] and len(a) in (5, 6): rename(a[1], int(a[2]), int(a[3]), a[4], a[5:] == ["--apply"])
    else: sys.exit(__doc__)
