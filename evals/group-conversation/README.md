# Group conversation behavior

Runs real models against the current group prompts, side chat digest, public history renderer, and delegation tool schema. Cases are authored Acme scenarios from the Phase 5 brief and the group UX review's "Behaviour evals". No captured user history is included.

## Decision rule, written before running

Keep `GROUP_PARALLEL = true` unless all of these conditions hold.

1. Serial improves mean engagement by at least 0.5 on the 0–4 scale in a strict majority of design cases **in each of the two model pairings**.
2. Each pairing's mean engagement gap is larger than the largest within-case range across repeated samples in either arm. At least three samples per case and pairing are required. A tie or a larger trial spread keeps parallel.
3. In a strict majority of cases in each pairing, the blind judge rates parallel redundancy at least 2, and explicitly classifies that overlap as noise rather than useful independent coverage.
4. Serial does not lower mean distinct ideas or surviving disagreement by more than 0.5 in either pairing.

Missing pairings, errors, truncated answers, or fewer trials make the decision inconclusive. Keep parallel for independent replies, isolation, and interjection. This is a conservative product rule, not a statistical significance claim. Do not change the rule after seeing results.

## Status

Behavior cases ran on 2026-11-16 with `morph-kimik31` and judge `morph-kimik3`, three samples each. On the earlier prompts `seat-adds-nothing-to-complete-answer` failed 0/3, with seats agreeing with and restating the primary's answer. On the current prompts it passes 2/3, and `seat-corrects-lead` and `lead-folds-in-correction` pass 3/3. The edit cases fail on that model because it writes absolute paths such as `/home/user/app/notes.txt`, which the simulated file store rejects; `ordinary-edit` uses no group text and fails the same way. The design comparison has not run, so the rule above has not been applied and `GROUP_PARALLEL = true` is only a default. The routing cases in `mcp-tool-use/cases/group-conversation.ndjson` have not run either. `primary-first-reply` has no failing baseline.

## Judge criteria

The four judge criteria are distinct useful ideas, explicit engagement with a peer's reasoning, surviving reasoned disagreement, and redundancy. Each uses 0–4 anchors in `grade.ts`. One judge scores both transcripts together on one scale. Random A/B order, neutral speaker names, and removal of model names hide the arm and provider. The judge sees no timing, cost, scheduling trace, or answer key. Candidates see organic requests and real product text, never the rubric or case metadata.

## Run

Put `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the repo root `.env`. The package script loads that file. Direct APIs are the default. `--proxy` explicitly uses the existing MCP eval's `vibeproxy` configuration for GPT models instead. `morph-` models, listed under Free in the table below, call Morph's free OpenAI-compatible API with `MORPH_API_KEY`, or the `morph` provider in OpenCode's config (`$XDG_CONFIG_HOME` or `~/.config`). Missing credentials produce error rows, never model substitutions or passing samples.

The model IDs below are the intended design pairings. They are not cheap shell models.

| Purpose     | Models                                                 |
| ----------- | ------------------------------------------------------ |
| Pairing 1   | `claude-opus-5-5,gpt-6-astra`                          |
| Pairing 2   | `claude-sonnet-5-5,gpt-6.1-sol`                        |
| Blind judge | `claude-sonnet-5-5`                                    |
| Free        | `morph-kimik31,morph-dsv41flash`, judge `morph-kimik3` |

```sh
cd evals
pnpm group-conversation --out runs/group-smoke --model claude-opus-5-5,gpt-6-astra --judge claude-sonnet-5-5 --case offline-sync --samples 1
pnpm group-conversation --out runs/group-small --model claude-opus-5-5,gpt-6-astra --model claude-sonnet-5-5,gpt-6.1-sol --judge claude-sonnet-5-5 --samples 3
pnpm group-conversation --out runs/group-dry --model claude-opus-5-5,gpt-6-astra --judge claude-sonnet-5-5 --samples 1 --dry-run
```

`--out` is required. `--model` accepts one model for behavior cases, or a comma-separated primary/seat pair for design cases. Repeat it for the two pairings. `--case` accepts comma-separated IDs. `--baseline <results.json>` compares behavior rates only with identical models, cases, settings, and grader hashes. Prompt hashes may differ because the purpose is to measure text changes. `--samples` defaults to 3. `--effort` defaults to high. The fixed reply budget is 220 words. Each request has a 120-second deadline. HTTP 429 and 5xx responses retry up to twice, waiting for `Retry-After` or 2 then 4 seconds, because they are transport, not model behaviour. Errors stay out of pass rates but prevent promotion. Existing output directories with results are rejected to prevent accidental overwrites.

Start with one case and one sample, inspect all requests and outputs, then run the small set. The default set has three design cases and fourteen behavior cases. Three samples and both pairings cost at most 312 participant turns and 174 judge calls before tool continuations. PASS and early closure can reduce design calls. File operations and delegation are simulated in memory. No real agent, file write, or child task is launched by a participant. Tools in the simulation can still fail the case. A behavior case passes only when a strict majority of its samples pass; errors make it incomplete.

## What the comparison simulates

A message to everyone starts only the primary. The seat's first turn is a reaction to the primary's reply, so both arms share that first hop, and `GROUP_PARALLEL` only decides whether several woken members react at once. With one seat the arms schedule identically; the flag matters only in larger groups.

The runner imports production policy and prompts. To exercise the other arm it loads `GroupConversation.ts` in memory with only the exported flag changed. No second scheduler is maintained. The production audience and budget helpers initialize both arms. Each wave reads one transcript snapshot, consumes its invocation budget, and advances each member's delivered cursor. Real `PASS`, final-line addressing, early close, and plain replies determine who wakes. Primary reactions use real public-history rendering and `renderPrimaryWakePrompt`. Seat turns use the real digest and `renderSeatFirstPrompt` or `renderSeatTurnPrompt`. Model order alternates with sample number, identically for both arms. Arm execution order also alternates. Requests preserve each member's private conversation.

This measures text behavior and the scheduler's information flow. It does not measure provider CLIs, streaming UI, interjection, tools on a real checkout, permissions, or provider-session persistence. The judge can share a family with a participant. Blinding reduces name and arm bias but does not eliminate style preference.

## Inspect the evidence

`results.json` holds each sample, prompts, final replies, commentary, simulated calls, file results, judge evidence, hashes, latency, token usage, errors, and the blind answer key. `calls.json` records every completed API call, including judge calls and usage from calls whose later grading failed. `summary.md` reports pass counts, errors, missing evidence, per-arm means, within-case trial ranges, and the decision against the rule. `prompts.json` is produced even in a dry run. Dry runs do not produce scored results. Never commit `runs/`.

Latency starts before each API request and ends after consuming its response. Discussion wall time includes the participant calls and excludes the judge. Serial sums its reaction calls; parallel waits for the slowest call in each wave. Tokens include input, cached input, output, and reasoning when the API exposes it. Cache hits, truncation, invalid judge JSON, refusals, and provider errors must be checked before interpreting a result. The timing limiter is the remote model/API, which this runner cannot profile. Treat timings as descriptive observations, not a measured product speedup.

USD estimates use the existing MCP eval's input/output/cache rates for the two listed Claude models. Other models and proxy billing are unpriced. The report gives their tokens and says that dollar cost is unavailable. Do not report unknown billing as $0. With no requests sent the measured API spend is $0. An incomplete API request can still incur unreported charges.

## Add a case

Add a data row in `cases.ts` with an ID, source, organic request, and judge-only criteria. Use a discussion row for an open design question. Use a behavior row for an authored prior exchange and one follow-up. Deterministic expectations cover PASS, actual handle parsing, simulated edits, and delegation. Semantic criteria require quoted evidence from the final answer. Controls cover ordinary work and side chats that should stay separate. When changing product text, run the case on the old text first and retain a failing baseline before rerunning the fix. Never weaken a case to make it pass.

Run grader and simulation tests with `vp test run evals/group-conversation/run.test.ts` from the repo root.
