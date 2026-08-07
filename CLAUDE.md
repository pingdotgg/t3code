AGENTS.md

<!-- prometheus-memory:start -->
## prom.codes Agent Memory

This workspace uses the prom.codes memory MCP server (`memory_*` tools).
Follow this protocol:

1. **Session start:** call `memory_read` once before non-trivial work to
   recall durable project knowledge from earlier sessions.
2. **During work:** when the user states a durable preference, decision,
   correction, or project fact ("merk dir …", "ab jetzt immer …"), store it
   via `memory_write` (type `semantic` for facts, `procedural` for
   how-tos). Prefer `memory_write` over runtime-native memory features for
   project knowledge, so it stays portable across tools.
3. **Looking things up:** use `memory_search` for keyword recall when
   `memory_read` output is not enough.
4. **Session end:** call `memory_capture` with a short plan/outcome summary
   and any new facts/procedures worth keeping.
5. **Never store secrets** (API keys, tokens, passwords) in memories —
   the server rejects them, but do not try.

Project-scoped facts mirror to `.prometheus/memories/*.md` (git-versioned,
human-editable); treat those files as the source of truth.
<!-- prometheus-memory:end -->

<!-- prom-saver:start -->
## prom.codes Saver — efficient output (level: balanced)

Cut token cost by writing less FILLER — without cutting quality or losing context. This shapes ONLY how you PHRASE your own messages: never code, commands, tool inputs, what you do, or what you need to remember. Trim ceremony, restating, padding and redundant examples; keep all substance.

Lead with the answer or the action; cut preamble, farewell pleasantries and play-by-play self-narration. Don't restate the question or pad. When several examples would be near-duplicates, give one. When recapping long tool or command output, keep the lines that carry meaning (failures, errors, the decision) and drop the noise. But include every step, caveat and precaution the answer needs to be correct and safe — if removing something would let a competent reviewer call the answer wrong, incomplete or unsafe, it stays. Lean, not terse: shorter because there is less filler, never because there is less help.

**Never cut substance (all levels) — these are never "filler":**
- Code, diffs, commit messages, CLI commands, API names, file paths and exact error strings — verbatim.
- Load-bearing caveats, trade-offs, warnings, negations ("not"/"only"/"unless"/"before"), and — for risky or destructive work — safer alternatives, precautions, dependency/foreign-key checks and backup/rollback advice. If it changes correctness or safety, keep it.
- Destructive, irreversible or multi-step sequences — spell those out in full, including every step the task needs to actually work (e.g. a "without downtime" procedure keeps the dual-running / grace-period steps).
- **Anything you will need on a later turn — your own working context.** What you write IS your memory of this turn; condensing a recap is never a reason to drop a file path, value, decision, finding or error you may act on again. When unsure whether a detail matters later, keep it.
- **The closing summary when you hand a task back.** Being lean applies to narrating work in progress, never to reporting it finished. When you finish a task — or stop and return control for any reason — write a complete summary: what you did, what changed (files, commands, commits), what you verified and what failed, what is still open, what you would do next. This is a *report*, not a "sign-off" — a "sign-off" is a farewell pleasantry ("let me know if you need anything else") and those still go. Skipping the report saves a handful of tokens and costs the user a follow-up question against a full context window — far more expensive than the summary would have been.

Correctness, safety, completeness and your own working context come FIRST; saving tokens comes second. If the two ever conflict, do not compress — cut filler, never substance.
<!-- prom-saver:end -->
