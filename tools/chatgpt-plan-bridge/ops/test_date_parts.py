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
print("date_parts rename self-test: 5 checks passed")
