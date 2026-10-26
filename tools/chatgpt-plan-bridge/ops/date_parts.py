#!/usr/bin/env python3
"""Luna stage 2 (STAGE2-DESIGN r2 18a291d1 §1, §3a): date MISSING transcript parts and rename them for one batch.

  date_parts.py plan <eligible.manifest> <run.manifest> <refused.tsv>
      eligible.manifest: "<hash16>\\t<legacy path>" rows (the §2 inventory's `missing` class).
      Writes run.manifest rows "<hash16>\\t<sha256>\\t<legacy path>\\t<dated path>\\t<date>", sorted by dated path,
      and refused.tsv rows "<hash16>\\t<legacy path>\\t<reason>". Reads only.
  date_parts.py rename <run.manifest> <first-row> <last-row> <renames.tsv> [--apply]
      Renames rows first..last (1-based, inclusive) legacy -> dated. Dry run unless --apply. Per row: the legacy file's
      sha256 must equal the manifest's, the dated path must not exist, and after the rename the dated file's sha256 must
      equal it again; each done rename is appended to renames.tsv.
  date_parts.py sessions-check <members.tsv> <run.manifest.sessions>
      §3a drop-only check before OPEN: lists members whose session jsonl grew since the freeze (exit 1), else exit 0. A row already renamed (dated present with the manifest
      sha256, legacy absent, recorded in renames.tsv) is skipped. Any other state stops the run with nothing further renamed.

Source date (§1): the UTC date of the part's first complete turn, found by a unique anchor (the turn's text up to the
next turn boundary, 40..200 chars) among the session jsonl's turns, raw or redacted. Every matching turn must carry a
valid zoned ISO timestamp and all must give one UTC date. Anything else is refused. No date is ever inferred.
"""
import datetime, glob, hashlib, importlib.util, os, re, sys, time

CONVERTER = "/root/.gbrain/ingest-session-transcript.py"
SRC_DIR = os.environ.get("DATE_PARTS_SRC_DIR", "/root/.claude/projects/-root")   # override: tests only
ANCH_MAX, ANCH_MIN, ACTIVE_S = 200, 40, 20 * 60
TURN_SEP = re.compile(r"\n\n(User|Assistant): ")
NAME = re.compile(r"^(?:(\d{4}-\d{2}-\d{2})-)?session-([0-9a-f-]{36})((?:\.part\d+)?)\.txt$")  # legacy or already dated

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
    sid = NAME.match(os.path.basename(path)).group(2)
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
        if not m: refused.append((h, p, "not-a-part-name")); continue
        named_day, sid, suffix = m.groups()
        if not suffix and glob.glob(os.path.join(os.path.dirname(p), f"*session-{sid}.part1.txt")):
            refused.append((h, p, "stale-single")); continue
        j = f"{SRC_DIR}/{sid}.jsonl"
        if os.path.exists(j) and time.time() - os.path.getmtime(j) < ACTIVE_S: refused.append((h, p, "active-session")); continue
        if named_day:   # already dated (the converter's exact turn date, or an earlier rename): nothing to rename
            if utc_date(f"{named_day}T00:00:00Z") != named_day: refused.append((h, p, "bad-name-date")); continue
            rows.append((h, sha256(p), p, p, named_day)); continue
        day, why = part_date(conv, p, cache)
        if why: refused.append((h, p, why)); continue
        dated = os.path.join(os.path.dirname(p), f"{day}-{os.path.basename(p)}")
        rows.append((h, sha256(p), p, dated, day))
    rows.sort(key=lambda r: r[3])
    with open(run_manifest, "w") as f:
        for r in rows: f.write("\t".join(r) + "\n")
    with open(refused_tsv, "w") as f:
        for r in refused: f.write("\t".join(r) + "\n")
    # §3a: the freeze baseline of every planned session's jsonl (size, mtime_ns). A session that grows after the
    # freeze has resumed; its members are dropped before OPEN (sessions-check), however unchanged their part bytes.
    with open(run_manifest + ".sessions", "w") as f:
        for sid in sorted({NAME.match(os.path.basename(r[2])).group(2) for r in rows}):
            st = os.stat(f"{SRC_DIR}/{sid}.jsonl"); f.write(f"{sid}\t{st.st_size}\t{st.st_mtime_ns}\n")
    print(f"plan: {len(rows)} dated, {len(refused)} refused, of {len(rows) + len(refused)} eligible rows")

def rename(run_manifest, first, last, renames_tsv, apply):
    rows = [l.rstrip("\n").split("\t") for l in open(run_manifest)][first - 1:last]
    done = {l.split("\t")[1] for l in open(renames_tsv)} if os.path.exists(renames_tsv) else set()
    for n, (h, sha, legacy, dated, day) in enumerate(rows, first):
        if legacy == dated:   # already dated at the run freeze: only its bytes are checked
            if not os.path.exists(dated) or sha256(dated) != sha: sys.exit(f"{n} STOP: dated part missing or changed {dated}")
            print(f"{n} skip (already dated) {os.path.basename(dated)}"); continue
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

def sessions_check(members, baseline):
    """Exit 0: no member's session grew since the freeze. Exit 1: the rows whose session grew (drop them before OPEN).
    Exit 2: evidence missing (a member's session absent from the baseline, or its jsonl unreadable)."""
    base = {l.split("\t")[0]: tuple(int(x) for x in l.rstrip("\n").split("\t")[1:3]) for l in open(baseline) if l.strip()}
    grew = []
    for l in open(members):
        h, sha, legacy, dated, day = l.rstrip("\n").split("\t")
        sid = NAME.match(os.path.basename(legacy)).group(2)
        if sid not in base: print(f"STOP: session {sid} has no freeze baseline"); sys.exit(2)
        try: st = os.stat(f"{SRC_DIR}/{sid}.jsonl")
        except OSError as e: print(f"STOP: session {sid} jsonl unreadable: {e}"); sys.exit(2)
        if (st.st_size, st.st_mtime_ns) != base[sid]: grew.append((h, legacy, sid))
    for h, legacy, sid in grew: print(f"session-grew\t{h}\t{legacy}\t{sid}")
    print(f"sessions-check: {len(grew)} member(s) of a session that grew since the freeze")
    sys.exit(1 if grew else 0)

def member_path(legacy, dated):
    return dated if os.path.exists(dated) else legacy

def bytes_check(members):
    """§3a source stability: every member's file (dated name if renamed, else legacy) still has the frozen sha256.
    Exit 0 all equal; 1 lists changed members; 2 a member file is missing."""
    bad = []
    for l in open(members):
        h, sha, legacy, dated, day = l.rstrip("\n").split("\t")
        p = member_path(legacy, dated)
        if not os.path.exists(p): print(f"STOP: member file missing (neither name): {legacy}"); sys.exit(2)
        if sha256(p) != sha: bad.append((h, p))
    for h, p in bad: print(f"bytes-changed\t{h}\t{p}")
    print(f"bytes-check: {len(bad)} member(s) changed since the freeze"); sys.exit(1 if bad else 0)

def eligible_check(members, inventory_json):
    """§2 eligibility re-checked before rename/admission from a fresh inventory run WITH renames.tsv (both aliases):
    each member must be class 'missing' at its current name. Exit 0 all; 1 lists the others with their class."""
    import json
    rows = {(r["hash16"], r["path"]): r["class"] for r in json.load(open(inventory_json))["rows"]}
    bad = []
    for l in open(members):
        h, sha, legacy, dated, day = l.rstrip("\n").split("\t")
        cls = rows.get((h, member_path(legacy, dated)), "not-discovered")
        if cls != "missing": bad.append((h, legacy, cls))
    for h, legacy, cls in bad: print(f"not-eligible\t{h}\t{legacy}\t{cls}")
    print(f"eligible-check: {len(bad)} member(s) no longer eligible"); sys.exit(1 if bad else 0)

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["plan"] and len(a) == 4: plan(*a[1:])
    elif a[:1] == ["rename"] and len(a) in (5, 6): rename(a[1], int(a[2]), int(a[3]), a[4], a[5:] == ["--apply"])
    elif a[:1] == ["sessions-check"] and len(a) == 3: sessions_check(a[1], a[2])
    elif a[:1] == ["bytes-check"] and len(a) == 2: bytes_check(a[1])
    elif a[:1] == ["eligible-check"] and len(a) == 3: eligible_check(a[1], a[2])
    else: sys.exit(__doc__)
