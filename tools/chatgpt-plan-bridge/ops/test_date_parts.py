# Self-test for date_parts.py rename (temp files only): dry run touches nothing, apply renames with the same bytes and
# records renames.tsv, a rerun skips, a changed source or an existing destination stops. Run: python3 -I test_date_parts.py
import hashlib, importlib.util, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); TOOL = os.path.join(HERE, "date_parts.py")
def run(*a): return subprocess.run([sys.executable, "-I", TOOL, *a], capture_output=True, text=True)
with tempfile.TemporaryDirectory() as d:
    sid = "11111111-2222-3333-4444-555555555555"
    legacy = [os.path.join(d, f"session-{sid}.part{i}.txt") for i in (1, 2)]
    for i, p in enumerate(legacy): open(p, "w").write(f"# Pingu session {sid}.part{i+1}\n\nUser: hello {i}\n")
    sha = [hashlib.sha256(open(p, "rb").read()).hexdigest() for p in legacy]
    dated = [os.path.join(d, f"2026-10-1{i+3}-" + os.path.basename(p)) for i, p in enumerate(legacy)]
    man, log = os.path.join(d, "run.manifest"), os.path.join(d, "renames.tsv")
    open(man, "w").write("".join(f"h{i}\t{sha[i]}\t{legacy[i]}\t{dated[i]}\t2026-10-1{i+3}\n" for i in range(2)))

    r = run("rename", man, "1", "2", log)  # dry run
    assert r.returncode == 0 and "would rename" in r.stdout and all(map(os.path.exists, legacy)) and not os.path.exists(log), r
    r = run("rename", man, "1", "1", log, "--apply")  # only row 1
    assert r.returncode == 0 and os.path.exists(dated[0]) and not os.path.exists(legacy[0]) and os.path.exists(legacy[1]), r
    assert hashlib.sha256(open(dated[0], "rb").read()).hexdigest() == sha[0] and len(open(log).readlines()) == 1
    r = run("rename", man, "1", "1", log, "--apply")  # rerun: skip, no new log row
    assert r.returncode == 0 and "skip" in r.stdout and len(open(log).readlines()) == 1, r
    open(legacy[1], "a").write("changed\n")  # row 2's bytes changed since the freeze: stop, nothing renamed
    r = run("rename", man, "2", "2", log, "--apply")
    assert r.returncode != 0 and "bytes changed" in r.stderr and os.path.exists(legacy[1]) and not os.path.exists(dated[1]), r
    open(legacy[1], "w").write(f"# Pingu session {sid}.part2\n\nUser: hello 1\n"); open(dated[1], "w").write("x")  # destination exists
    r = run("rename", man, "2", "2", log, "--apply")
    assert r.returncode != 0 and "destination exists" in r.stderr and os.path.exists(legacy[1]), r
    # An already-dated part (legacy == dated): checked, never renamed; changed bytes stop.
    pre = os.path.join(d, f"2026-10-20-session-{sid}.part3.txt"); open(pre, "w").write("dated already\n")
    psha = hashlib.sha256(open(pre, "rb").read()).hexdigest(); man2 = os.path.join(d, "run2.manifest")
    open(man2, "w").write(f"h3\t{psha}\t{pre}\t{pre}\t2026-10-20\n")
    r = run("rename", man2, "1", "1", log, "--apply")
    assert r.returncode == 0 and "already dated" in r.stdout and os.path.exists(pre) and len(open(log).readlines()) == 1, r
    open(pre, "a").write("x"); r = run("rename", man2, "1", "1", log, "--apply")
    assert r.returncode != 0 and "missing or changed" in r.stderr, r
    # sessions-check (§3a, Pebble 18:36Z): a member whose session jsonl grew since the freeze baseline is listed (exit 1).
    src = os.path.join(d, "src"); os.makedirs(src); j = os.path.join(src, f"{sid}.jsonl"); open(j, "w").write('{"a":1}\n')
    st = os.stat(j); base = os.path.join(d, "run.manifest.sessions"); open(base, "w").write(f"{sid}\t{st.st_size}\t{st.st_mtime_ns}\n")
    mem = os.path.join(d, "members.tsv"); open(mem, "w").write(f"h0\t{sha[0]}\t{legacy[0]}\t{dated[0]}\t2026-10-13\n")
    chk = lambda: subprocess.run([sys.executable, "-I", TOOL, "sessions-check", mem, base], capture_output=True, text=True,
                                 env=dict(os.environ, DATE_PARTS_SRC_DIR=src))
    r = chk(); assert r.returncode == 0 and "0 member(s)" in r.stdout, r
    open(j, "a").write('{"b":2}\n'); r = chk()   # the session resumed: its jsonl grew, the part bytes did not change
    assert r.returncode == 1 and f"session-grew\th0\t{legacy[0]}\t{sid}" in r.stdout, r
    open(base, "w").write("ffffffff-0000-0000-0000-000000000000\t1\t1\n"); r = chk()
    assert r.returncode == 2 and "no freeze baseline" in r.stdout, r
    open(base, "w").write(f"{sid}\t1\t1\n"); os.remove(j); r = chk()
    assert r.returncode == 2 and "unreadable" in r.stdout, r
print("date_parts rename + sessions-check self-test: 11 checks passed")
