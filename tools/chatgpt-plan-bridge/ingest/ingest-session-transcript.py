#!/usr/bin/env python3
# Session-end: convert Claude Code session .jsonl -> clean conversation .txt
# into the gbrain corpus, so the hourly dream extracts atoms+concepts from
# real lived sessions (Option C, forward-only). S300. Local-only, no LLM.
import json, sys, os, glob, re, time, datetime
SRC_DIR="/root/.claude/projects/-root"
OUT_DIR="/root/.claude/projects/-root/session-text"  # under corpus dir → dream picks .txt up
os.makedirs(OUT_DIR, exist_ok=True)
def clean_text(v):
    # content may be str or list of {type:text,text:..}
    if isinstance(v,str): return v
    if isinstance(v,list):
        out=[]
        for b in v:
            if not isinstance(b,dict): continue
            if b.get("type")=="text" and b.get("text"): out.append(b["text"])
            # S479 (Nazz: "brain does not carry that data"): tool results carried the densest estate facts
            # (CI logs, psql/ssh output, config dumps) and were dropped entirely. Keep a bounded,
            # fact-bearing slice of each result so gbrain dream can extract from it.
            elif b.get("type")=="tool_result":
                c=b.get("content")
                t=c if isinstance(c,str) else "\n".join(x.get("text","") for x in c if isinstance(x,dict)) if isinstance(c,list) else ""
                t=t.strip()
                if len(t)>=40 and FACT_RE.search(t): out.append("ToolResult: "+t[:1500])
        return "\n".join(out)
    return ""
FACT_RE=re.compile(r"(sha256|[0-9a-f]{8,}|/[A-Za-z0-9_.-]+/|\bnot ok\b|\bok\b|FAILED|PASS|HOLD|role |GRANT|SET ROLE|comment=|=\S)")
CHANNEL_RE=re.compile(r"<channel[^>]*user=\"([^\"]+)\"[^>]*>(.*?)</channel>", re.S)
# S552: never carry a credential into the corpus. URL passwords (S523) were the only rule; env/JSON/YAML assignments,
# PEM blocks and known token formats passed through (live Neon owner passwords + the TinyFish key reached the corpus).
# Pattern-based: "no hit" is not "secret-free". Idempotent: "[REDACTED]" matches none of these.
R = "[REDACTED]"
_STRONG = re.compile(r"(?i)(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|credential|auth[_-]?key|license(?:[_-]?key)?)")
# NAME sep VALUE: env (NAME=v, NAME: v), JSON ("name":"v"), YAML (name: 'v'); name may be camelCase (licenseKey)
_ASSIGN = re.compile(r"(\b(?=[A-Za-z])[A-Za-z0-9_.-]*?(?:[Kk]ey|KEY|[Ss]ecret|SECRET|[Tt]oken|TOKEN|[Pp]assw(?:or)?d|PASSW(?:OR)?D|[Pp]wd|PWD|[Cc]redential|CREDENTIAL|[Ll]icense|LICENSE)[A-Za-z0-9_]*[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9/+_.~-]{8,}={0,2})")
_CODE_REF = re.compile(r"^(?:process\.env|os\.environ|secrets\.|settings\.|self\.|config\.|args\.|env\.)", re.I)
_DOTTED = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\(\))?")   # code reference: a.b.c / a.b()
_CAMEL = re.compile(r"(?:[A-Z][a-z]{2,}|[a-z]{2,})(?:[A-Z][a-z]{2,})+")                        # handleStoreSelection / FleetStatusToken
_WORDS = re.compile(r"[a-z0-9]+(?:[._/-][a-z0-9]+)*/?")                                         # kebab/snake/path word chains
def _wordish(v): return bool(_DOTTED.fullmatch(v) or _CAMEL.fullmatch(v) or _WORDS.fullmatch(v))
def _credential_shaped(v, strong):
    if _DOTTED.fullmatch(v) and not (strong == "password" and re.fullmatch(r"[a-z0-9.]+", v)): return False   # under a password name, lowercase dots may BE the password
    if _CODE_REF.match(v) or (v.upper() == v and "_" in v and not any(c.isdigit() for c in v)): return False  # code ref / ENV_VAR_NAME placeholder
    hi_entropy = (len(v) >= 16 and not re.search(r"[._/~-]", v) and re.search(r"[a-z]", v) and re.search(r"[A-Z]", v) and not _CAMEL.fullmatch(v)) \
        or re.fullmatch(r"[a-z0-9]{32,}|[A-Z0-9]{32,}", v.rstrip("="))                       # random mixed case / long hex-like
    if hi_entropy: return True
    if re.fullmatch(r"[a-z0-9][a-z0-9._-]*(?:/[a-z0-9._-]+)+/?", v): return False   # lowercase slash path = a secret's NAME (Secrets Manager id)
    if strong == "password" and len(v) >= 6: return True   # passwords can be plain words
    return bool(strong) and len(v) >= 12 and bool(re.search(r"\d", v)) and bool(re.search(r"[A-Za-z]", v))
def _assign(m):
    name, v = m.group(1), m.group(2)
    strong = "password" if re.search(r"(?i)passw(?:or)?d|pwd", name) else bool(_STRONG.search(name))
    return name + R if _credential_shaped(v, strong) else m.group(0)
_REDACT_RULES = [
    (re.compile(r"-----BEGIN ([A-Z ]*)PRIVATE KEY-----.*?(?:-----END \1PRIVATE KEY-----|\Z)", re.S), r"-----BEGIN \1PRIVATE KEY-----" + R + r"-----END \1PRIVATE KEY-----"),
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://[^\s:/@\"]+:)[^\s@\"]+@"), r"\1" + R + "@"),
    (_ASSIGN, _assign),
    (re.compile(r"(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"), R),
]
def _rules(txt):
    for rx, rep in _REDACT_RULES: txt = rx.sub(rep, txt)
    return txt
def secret_values(txt):
    """The original spans the rules replaced (recovered by aligning the redacted text back onto the original)."""
    r = _rules(txt)
    if r == txt: return set()
    m = re.fullmatch("(.+?)".join(re.escape(x) for x in r.split(R)), txt, re.S)
    return {v for v in (m.groups() if m else ()) if len(v) >= 12 and not _wordish(v) and not v.startswith(("${", "<", "{", "%"))}   # word-like values are redacted in place, never propagated
def redact_text(txt, known=frozenset()):
    vals = set(known) | secret_values(txt)
    txt = _rules(txt)
    for v in sorted(vals, key=len, reverse=True):
        if len(v) >= 12: txt = txt.replace(v, R)
    return txt
def convert(jsonl):
    sid=os.path.basename(jsonl).replace(".jsonl","")
    turns=[]; stamps=[]
    for line in open(jsonl, errors="replace"):
        try: o=json.loads(line)
        except: continue
        msg=o.get("message") if isinstance(o.get("message"),dict) else o
        role=msg.get("role") or o.get("type")
        if role not in ("user","assistant"): continue
        txt=clean_text(msg.get("content"))
        # S479: Discord messages arrive as <channel ...>TEXT</channel> and were dropped by the "<" rule —
        # every directive Nazz gave over Discord was invisible to the corpus. Keep them, attributed.
        m=CHANNEL_RE.search(txt or "")
        if m: txt="Discord message from "+m.group(1)+": "+m.group(2).strip()
        # drop system-reminders, cron prompts, empty
        if not txt or txt.strip().startswith(("<", "[gbrain-", "[mnemo-")): continue
        txt=re.sub(r'<system-reminder>.*?</system-reminder>','',txt,flags=re.S).strip()
        if len(txt)<15: continue
        turns.append(("User" if role=="user" else "Assistant")+": "+txt)
        stamps.append(o.get("timestamp"))
    if len(turns)<4: return None  # trivial session, skip
    # S523 URI passwords + S552 env/JSON/YAML/PEM/known-format secrets. Per turn (a fail-safe unterminated PEM stays inside its
    # turn), with values labeled anywhere in the session also redacted where they appear bare in another turn.
    known=set().union(*(secret_values(t) for t in turns))
    red=[redact_text(t, known) for t in turns]
    body="\n\n".join(red)
    starts=[]; off=0
    for t in red: starts.append(off); off+=len(t)+2
    # cap per-file at 40k chars; split into parts so whole session is covered
    parts=[body[i:i+16000] for i in range(0,len(body),16000)] or [body]
    # S553: a new part is named by the UTC date of the first turn that starts inside it, as a leading
    # YYYY-MM-DD (the prefix gbrain reads as the file's date); a part that already exists keeps its name.
    # Every path is resolved before any write, so a refused part leaves the session's files untouched.
    plan=[]
    for i,p in enumerate(parts):
        suffix="" if len(parts)==1 else f".part{i+1}"
        first=next((k for k,s in enumerate(starts) if i*16000<=s<(i+1)*16000), None)
        plan.append((part_path(sid, suffix, utc_date(stamps[first]) if first is not None else None), suffix, p))
    written=[]
    for fn,suffix,p in plan:
        open(fn,"w").write(f"# Pingu session {sid}{suffix}\n\n{p}")
        written.append(fn)
    return written
def utc_date(ts):
    """UTC YYYY-MM-DD of an ISO timestamp with a zone; None when missing, zone-less or invalid."""
    try: t=datetime.datetime.fromisoformat(str(ts).replace("Z","+00:00"))
    except ValueError: return None
    return t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%d") if t.tzinfo else None
def part_path(sid, suffix, day):
    """The file for one (session, part): the existing legacy or dated name, else the dated name for a new part
    (legacy when there is no date). Both names existing at once is refused, never resolved by guessing."""
    legacy=f"{OUT_DIR}/session-{sid}{suffix}.txt"
    dated=[f for f in glob.glob(f"{OUT_DIR}/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-session-{glob.escape(sid)}{suffix}.txt")]
    if os.path.exists(legacy) and dated or len(dated)>1:
        raise RuntimeError(f"two files for session {sid}{suffix}: {[legacy]+dated if os.path.exists(legacy) else dated}")
    if os.path.exists(legacy): return legacy
    if dated: return dated[0]
    return f"{OUT_DIR}/{day}-session-{sid}{suffix}.txt" if day else legacy
def is_quiet(jsonl, minutes=20):
    """A session still being written to is NOT safe to convert."""
    return (time.time() - os.path.getmtime(jsonl)) > minutes*60

def already_converted(jsonl):
    """Converted AFTER its last write ⇒ nothing new to stage."""
    sid=os.path.basename(jsonl).replace(".jsonl","")
    outs=glob.glob(f"{OUT_DIR}/*session-{glob.escape(sid)}*.txt")  # S553: legacy or dated names
    if not outs: return False
    return max(os.path.getmtime(o) for o in outs) >= os.path.getmtime(jsonl)

if __name__=="__main__":
    # --sweep: SAFETY NET for a missed SessionEnd (S392).
    # The drain moved from the Stop hook (fired every response, atomised live
    # transcripts) to SessionEnd. But SessionEnd does NOT fire on a crash/kill —
    # and this script only ever converted the single newest .jsonl, so a session
    # that died abnormally was never staged, and Mnemo cannot drain a corpus it
    # was never written to. Sweep converts every QUIET, unconverted session.
    if "--sweep" in sys.argv:
        n=0
        for f in sorted(glob.glob(f"{SRC_DIR}/*.jsonl")):
            if not is_quiet(f) or already_converted(f): continue
            try: w=convert(f)
            except RuntimeError as e: print(f"[session-ingest:sweep] REFUSED {os.path.basename(f)}: {e}"); continue
            if w: n+=1; print(f"[session-ingest:sweep] {os.path.basename(f)} -> {len(w)} file(s)")
        print(f"[session-ingest:sweep] staged {n} previously-unconverted session(s)")
        sys.exit(0)
    # arg = specific jsonl, else newest. No quiet-guard here: SessionEnd is an
    # explicit "this session is over, convert it now" signal.
    f=sys.argv[1] if len(sys.argv)>1 else max(glob.glob(f"{SRC_DIR}/*.jsonl"), key=os.path.getmtime)
    w=convert(f)
    print(f"[session-ingest] {os.path.basename(f)} -> {len(w) if w else 0} file(s)" + (f": {w}" if w else " (skipped, trivial)"))
