# Self-test for the S553 converter candidate (stage 2 §1): dated names for new parts, the existing name wins,
# both names at once is refused before any write, already_converted sees dated names. Run: python3 -I test_converter.py
import importlib.util, json, os, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("conv", os.path.join(HERE, os.environ.get("CONV", "ingest-session-transcript.py")))
conv = importlib.util.module_from_spec(spec); spec.loader.exec_module(conv)

def session(dirpath, sid, turns):
    p = os.path.join(dirpath, f"{sid}.jsonl")
    with open(p, "w") as f:
        for role, text, ts in turns: f.write(json.dumps({"type": role, "timestamp": ts, "message": {"role": role, "content": text}}) + "\n")
    return p

def run():
    with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as out:
        conv.OUT_DIR = out
        big = "word " * 2400  # 12,000 chars: turn k starts near 12,000*k, so parts 1/2/3 each hold exactly one start (turn 0/2/3)
        sid = "11111111-2222-3333-4444-555555555555"
        j = session(src, sid, [("user", "first question " + big, "2026-10-13T10:00:00Z"),
                               ("assistant", "first answer " + big, "2026-10-13T10:01:00Z"),
                               ("user", "second question " + big, "2026-10-13T23:59:00-05:00"),
                               ("assistant", "second answer " + big, "2026-10-15T10:01:00Z")])
        w = conv.convert(j)
        names = [os.path.basename(x) for x in w]
        # part1 (0-16k): turns 0,1 start -> first is turn 0, 10-13. part2 (16k-32k): turn 2 (-05:00 across midnight
        # -> 10-14 UTC). part3 (32k-48k): turn 3 -> 10-15. part4 holds no turn start -> keeps the legacy name.
        assert names == [f"2026-10-13-session-{sid}.part1.txt", f"2026-10-14-session-{sid}.part2.txt",
                         f"2026-10-15-session-{sid}.part3.txt", f"session-{sid}.part4.txt"], names
        assert conv.already_converted(j) is True  # dated names are seen as this session's outputs

        # An existing legacy name wins: rename part1 back to its legacy name, re-convert, no dated twin appears.
        legacy1 = os.path.join(out, f"session-{sid}.part1.txt")
        os.rename(os.path.join(out, names[0]), legacy1)
        before = open(legacy1).read()
        w2 = conv.convert(j)
        assert legacy1 in w2 and not os.path.exists(os.path.join(out, names[0])), w2
        assert open(legacy1).read() == before  # same bytes: same body, same name

        # Both names for one part: refused before ANY write (part1 untouched too).
        twin = os.path.join(out, f"session-{sid}.part2.txt"); open(twin, "w").write("legacy twin")
        m1 = os.stat(legacy1).st_mtime_ns
        try: conv.convert(j); raise AssertionError("expected a refusal")
        except RuntimeError as e: assert "two files" in str(e)
        assert os.stat(legacy1).st_mtime_ns == m1 and open(twin).read() == "legacy twin"
        os.remove(twin)

        # A zone-less or missing timestamp keeps the legacy name for a new part.
        sid2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        j2 = session(src, sid2, [("user", "q " + "x " * 20, "2026-10-13T10:00:00"), ("assistant", "a " + "y " * 20, None),
                                 ("user", "q2 " + "x " * 20, None), ("assistant", "a2 " + "y " * 20, None)])
        assert [os.path.basename(x) for x in conv.convert(j2)] == [f"session-{sid2}.txt"]

        # utc_date contract.
        assert conv.utc_date("2026-10-13T23:30:00-05:00") == "2026-10-14" and conv.utc_date("2026-10-13T18:10:22.133Z") == "2026-10-13"
        assert conv.utc_date(None) is None and conv.utc_date("2026-10-13T18:10:22") is None and conv.utc_date("junk") is None
    print("converter self-test: 5 checks passed")

run()
