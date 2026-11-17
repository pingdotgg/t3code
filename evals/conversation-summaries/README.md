# Conversation summaries

Checks how background text generation reads a conversation, using the prompts from this checkout. A leaf summary covers one exchange, including a reply from another model in the thread. A roll-up condenses four adjacent summaries, as the summary pass does for long threads.

Tool fixtures pass through production `summaryToolText` before generation. The payload cases check both that binary bytes never reach the model and that the resulting summary retains the adjacent text evidence. Other cases cover conflicting tool results and success claims, partial source ranges, and instructions embedded in historical evidence. Citation checks reject invented refs, including a mix of valid and invented refs, and require the relevant source for selected factual claims. These bounded checks complement manual reading; they are not a general factuality judge.

The production summarizer is an OpenCode model. A `gpt-*` model calls the server's real Codex generator through the local Codex login. A `morph-*` model calls Morph's free API directly, using the production prompt builders and reply decoder. The key comes from `MORPH_API_KEY`, or else from the `morph` provider in `~/.config/opencode/opencode.json`.

```sh
cd evals
pnpm conversation-summaries --model morph-kimik31 --arm main --samples 8 --out runs/peer-main
pnpm conversation-summaries --model morph-kimik31 --arm full --samples 8 --out runs/peer-full --baseline runs/peer-main/results.json
```

| Morph model        | Comparison |
| ------------------ | ---------- |
| `morph-kimik31`    | Kimi       |
| `morph-dsv41flash` | DeepSeek   |

For a payload baseline, export the earlier production `conversationEvidence.ts` outside the repository with `git show <base>:packages/provider-core/src/server/conversationEvidence.ts`, then pass its absolute path with `--evidence-module`. Run the same cases and model without that flag for the current normalizer. This changes evidence normalization only; `--arm` still controls peer attribution. `run.json` records the selected model, arm and evidence module. Results are saved after each sample so a provider error does not lose earlier outputs. An interrupted run is incomplete, not a model failure.

`--arm` sets how a peer reply reaches the model, so the arms compare from one checkout:

- `main` sends it as a nameless assistant message, as `main` does. Its leaf case fails by construction, because the name the grader wants is not in the input.
- `peer-as-user` renders it as a historical user message with the speaker in its header, as handoff history renders a peer.
- `full` is this checkout, where it carries the peer's name. It is the default.

Cases:

- `condensed-four-sources-retain-reversal-and-unverified-claim` passes when the roll-up keeps the later Postgres decision instead of the reversed Redis one, keeps the agent's test claim attributed and unverified, keeps the open rollback script, cites only the given summaries, and fits in 1,200 characters.
- `condensed-four-ordinary-sources` is the control: an ordinary docs task that must keep its open item and fit the same budget.
- `condensed-counts-and-qualifiers-stay-exact` preserves separate failed and passed counts and distinguishes no open pull request from no pull request at all.
- `condensed-later-evidence-resolves-earlier-unknown` keeps a later resolution and distinguishes a design requirement from observed test coverage.
- `leaf-peer-proposal-is-not-a-user-decision` passes when the summary names Astra as the one who proposed Postgres, and credits that proposal to neither the user nor the agent.
- `leaf-ordinary-exchange-has-no-peer` is the leaf control: an ordinary docs task with no peer.
- `leaf-image-envelope-keeps-text-evidence` and `leaf-attachment-envelope-retains-failure` reject raw image/PDF bytes while retaining layout and ledger failures.
- `leaf-tool-failure-overrides-success-claim` preserves a failing command despite the assistant's contrary claim.
- `leaf-partial-source-does-not-invent-outcome` keeps the result unknown when only the start of a long source is available.
- `leaf-source-instructions-are-not-summary-instructions` keeps failed-backup evidence and rejects instructions to fabricate a success or citation.
- `leaf-peer-correction-survives-primary-agent-wake` keeps Astra's corrected finding attributed to Astra despite an intervening notice naming the primary agent.
- `--case <ids>` limits the run, and `--samples <n>` sets samples per case (default 3). A case fails when half or more of its samples fail. Read the statements in `results.json` as well as the automated result.

## Add a case

Add a condensed entry to `cases.ts` with an `id`, a `kind`, a `source`, the four child `summaries`, and the regex checks. A leaf entry has `messages` instead of `summaries`. `run.test.ts` tests the grader.

## Cost

A `morph-*` sample is free but rate limited to about 24,000 uncached input tokens a minute; the runner waits out `Retry-After`. A `gpt-*` sample is one call on the local subscription. The CLI does not report per-call cost.
