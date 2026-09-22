# GBRAIN-S492 local patch dispositions

Base audited: `origin/backup/local-patches` @ `255117e9`; candidate upstream: `upstream/master` @ `9b0a1b5e` (v0.51.6.0). `KEEP-REBASED` means the local invariant is retained on the candidate architecture. `DROP-UPSTREAM-HAS-IT` names the candidate mechanism that supersedes the patch. `DROP-OBSOLETE` means the old mechanism or experiment no longer applies. Ambiguous unique local behavior is retained rather than silently discarded.

| # | local commit | disposition | evidence |
|---:|---|---|---|
| 1 | `44ce4e87` | DROP-UPSTREAM-HAS-IT | Candidate reindex/extraction uses current chunker/contextual-state drift predicates and resumable watermarks; the old stale-pre-version sweep is superseded. |
| 2 | `b5b364c0` | KEEP-REBASED | Candidate has the retrieval-reflex resolver but no `reflex_pointers` operation; retain the thin read-only operation and contract test. |
| 3 | `c6c3edff` | DROP-UPSTREAM-HAS-IT | `extract-takes-from-pages.ts` resolves the configured/default chat model and recognizes local providers before applying paid-model budget logic. |
| 4 | `7ca053be` | DROP-OBSOLETE | Candidate doctor/reindex architecture no longer performs the legacy blanket `needsReindex` receipt scan this patch amended. |
| 5 | `d13cd704` | DROP-UPSTREAM-HAS-IT | Candidate canonical import/persistence paths own receipt and content-revision updates transactionally; the legacy post-write receipt helper is superseded. |
| 6 | `5d55cb73` | DROP-UPSTREAM-HAS-IT | Same candidate persistence revision contract as #5; no separate legacy overwrite repair remains to carry. |
| 7 | `8195aa13` | DROP-UPSTREAM-HAS-IT | Candidate `ollama` recipe already declares a chat touchpoint and exercises chat-model resolution. |
| 8 | `5bab622f` | DROP-UPSTREAM-HAS-IT | Candidate extraction limits are config-backed and its cost gate disables spend enforcement for free local models; the hardcoded `$1000` surrogate is obsolete. |
| 9 | `66698c3d` | DROP-UPSTREAM-HAS-IT | Candidate server has `GBRAIN_DRAIN_TIMEOUT_MS`, bounded drain, and forced socket teardown. |
| 10 | `03de3246` | DROP-UPSTREAM-HAS-IT | Candidate model pricing recognizes local providers as zero-cost and bypasses paid-provider budget enforcement. |
| 11 | `b039cb29` | KEEP-REBASED | Candidate still ships the tweet/virality atom prompt; retain the measured local durable-engineering prompt with an unchanged output schema. |
| 12 | `1422baed` | KEEP-REBASED | Paired scratch evidence disproved the original drop: alias-synonym Hit@1 fell from pin 100% to candidate 0%. Retain `1cdd1785` semantics so an exact human-authored alias promotes an already-present canonical to top-of-organic, matching the absent-injection branch. |
| 13 | `7622b265` | DROP-OBSOLETE | This was an intentionally negative measured knob; its own disposition says leave the default unchanged. |
| 14 | `9df9a586` | DROP-UPSTREAM-HAS-IT | Candidate context/retrieval-reflex resolver and transcript handling include the upstream retry/alias-resolution rebuild. |
| 15 | `23f7c999` | DROP-UPSTREAM-HAS-IT | Candidate doctor and reranker readiness are model-scoped and encoding-safe in the newer modular health implementation. |
| 16 | `8796c143` | DROP-OBSOLETE | The legacy completion-audit event shape and monolithic doctor insertion point no longer exist; candidate exposes current provider/cycle failure telemetry instead. |
| 17 | `c2829831` | DROP-UPSTREAM-HAS-IT | Candidate provider/model pricing registry supersedes the one-model OpenRouter override. |
| 18 | `5899fa6c` | DROP-UPSTREAM-HAS-IT | Candidate fact eligibility/expiry handling excludes expired facts from extraction and consolidation paths. |
| 19 | `71a272f4` | DROP-UPSTREAM-HAS-IT | Candidate charges/attributes the actual returned model and supports configured pricing overrides. |
| 20 | `e750de88` | DROP-UPSTREAM-HAS-IT | Candidate contradiction tooling separates temporal supersession from genuine current-value disagreement. |
| 21 | `70a387c5` | DROP-OBSOLETE | The pre-v0.51 search-fusion demotion experiment is superseded by exact-lookup, evidence classification, lifecycle filtering, and autocut. |
| 22 | `32449d7f` | DROP-UPSTREAM-HAS-IT | Candidate alias hops are typed, bounded, source-scoped, and resolved in the dedicated retrieval-reflex/exact-lookup layers. |
| 23 | `6fe6a512` | KEEP-REBASED | Candidate still leaves `generic-to-named` soft; retain the measured 0.60 Hit@3 regression floor used by the nightly gate. |
| 24 | `647daf50` | DROP-UPSTREAM-HAS-IT | Candidate zero-cost local embedding/chat providers do not consume the paid budget tracker. |
| 25 | `726c69d1` | DROP-UPSTREAM-HAS-IT | Candidate retrieval results carry effective/source dates through current result metadata and chronology-aware ranking. |
| 26 | `e5b29e6b` | KEEP-REBASED | Paired scratch evidence disproved the original drop: hard-negative fell from pin 100% to candidate 88% because local `status: superseded` / `superseded_by` markers were ignored and the reranker erased pre-rerank penalties. Retain the marker-aware demotion and post-rerank ordering semantics of `b426184f` + `9ac7d5fb`. |
| 27 | `409bb756` | KEEP-REBASED | Candidate still renders unqualified nearest neighbors without an all-weak warning; retain the CLI-only UNKNOWN signal without changing result shape/ranking. |
| 28 | `9a196bce` | DROP-UPSTREAM-HAS-IT | Candidate graph health and traversal use typed live edges in both directions; the old one-direction raw-link count is superseded. |
| 29 | `424a01dd` | DROP-UPSTREAM-HAS-IT | Candidate minion write paths preserve job/source attribution in current operation receipts and progress metadata. |
| 30 | `02006207` | DROP-UPSTREAM-HAS-IT | Candidate source attribution is threaded through federated cycle/import/write paths rather than patched at the legacy minion wrapper. |
| 31 | `8fb6144e` | DROP-UPSTREAM-HAS-IT | Candidate cycle phases use refreshing leases and cooperative yield hooks throughout long work. |
| 32 | `10510599` | DROP-UPSTREAM-HAS-IT | Candidate queue ownership and lease-renewal code covers nested/private subagent queues. |
| 33 | `a8ac1137` | DROP-UPSTREAM-HAS-IT | Candidate verifies ownership before eviction and reaps only dead-holder namespace/host locks. |
| 34 | `1ad6864a` | DROP-UPSTREAM-HAS-IT | Candidate atom identity uses deterministic source-bound normalized slugs/hashes with legacy-row adoption. |
| 35 | `e52b4d9f` | DROP-UPSTREAM-HAS-IT | Candidate synthesize-concepts/subagent work is deadline- and lease-bounded with resumable outputs. |
| 36 | `4f85bed7` | DROP-UPSTREAM-HAS-IT | Candidate shared pricing/cost-gate code recognizes local aliases and local provider families as free. |
| 37 | `9925afe8` | DROP-UPSTREAM-HAS-IT | Candidate gateway performs provider/model capability and context checks before long cycle work. |
| 38 | `26551322` | DROP-UPSTREAM-HAS-IT | Candidate full-cycle dispatch floor derives from the handler timeout anchors, eliminating the duplicated literal. |
| 39 | `b8471e75` | DROP-UPSTREAM-HAS-IT | Candidate destructive operations are guarded/previewed and ordinary delete remains soft-delete first. |
| 40 | `170b6a79` | DROP-UPSTREAM-HAS-IT | Candidate persistence layer records guarded destructive transitions and handles artifact/row deletion transactionally. |
| 41 | `2182eafd` | DROP-UPSTREAM-HAS-IT | Candidate LLM JSON paths strip reasoning blocks and preserve current provider completion semantics. |
| 42 | `1bb00e7d` | DROP-UPSTREAM-HAS-IT | Candidate search/recall result contracts include effective/update chronology fields used by current clients. |
| 43 | `f0cc8cf9` | KEEP-REBASED | Candidate routine `extract_atoms` still has no per-phase wall-clock bound; retain the resumable 15-minute stop and abort seam. |
| 44 | `a834eec9` | KEEP-REBASED | Candidate defaults remain 3 atoms/4096 tokens; retain the measured local 8-atom/8192-token envelope. |
| 45 | `96fb9226` | KEEP-REBASED | Candidate handler anchors remain 30 minutes although production evidence requires a 60-minute full-cycle envelope; rebase at the shared anchor. |
| 46 | `d88d12ef` | KEEP-REBASED | Candidate patterns still assembles an unbounded reflection corpus; retain the 32,000-char cap. The candidate derives propose-takes headroom from the shared handler deadline, so #45 supplies the equivalent 60-minute outer envelope. |
| 47 | `a2cf12b4` | DROP-OBSOLETE | Rolled-back S409 search experiment; current retrieval defect is explicitly a separate successor and this build must not redesign fusion. |
| 48 | `0f06b4de` | DROP-OBSOLETE | Same rolled-back S409 experiment; superseded by current evidence/relational/exact-lookup architecture. |
| 49 | `c56035a5` | DROP-OBSOLETE | Same rolled-back S409 experiment; not reintroduced during an upgrade-only build. |
| 50 | `d7d65f01` | DROP-OBSOLETE | S409 observability patch targeted the retired experiment and does not justify restoring its pipeline. |
| 51 | `e601a5f1` | DROP-OBSOLETE | S409 alias-stage experiment is outside the upgrade object and superseded by candidate exact/alias tiers. |
| 52 | `96ca6d02` | DROP-OBSOLETE | S409 fusion experiment is explicitly kept separate from the unresolved retrieval successor. |
| 53 | `09a02cf6` | DROP-OBSOLETE | S409 eval expectation patch is tied to the retired experiment, not the candidate’s current retrieval contract. |
| 54 | `b1fd37ff` | DROP-OBSOLETE | S409 migration/schema addition belonged to the retired experiment; carrying it would violate the no-search-redesign boundary. |
| 55 | `7b60f119` | DROP-UPSTREAM-HAS-IT | Candidate propose-takes has configurable input/output caps, truncation retry, and bounded per-call timeouts. |
| 56 | `c2268d2e` | DROP-UPSTREAM-HAS-IT | Candidate rerank pipeline preserves full `SearchResult` identity/metadata while applying rerank scores/order. |
| 57 | `f436ad14` | KEEP-REBASED | Candidate JSON has aggregate/question scores but nightly stderr lacks stable ranked-list + fixture-truth rows; retain PQ/PQS evidence. |
| 58 | `c2e62408` | DROP-UPSTREAM-HAS-IT | Candidate structural exact-lookup promotes normalized exact title/slug matches after fusion and preserves them through autocut. |
| 59 | `4ad3d30e` | DROP-UPSTREAM-HAS-IT | Candidate lockfile/package set is newer and already contains post-patch dependency resolutions; do not regress pins. |
