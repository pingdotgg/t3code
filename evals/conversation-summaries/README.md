# Conversation summaries

Checks how background text generation reads a conversation, using the prompts from this checkout. A leaf summary covers one exchange, including a reply from another model in the thread. A roll-up condenses four adjacent summaries, as the summary pass does for long threads. A knowledge case sends the same exchange to assisted learning and grades the fact candidates it returns.

The production summarizer is an OpenCode model. A `gpt-*` model calls the server's real Codex generator through the local Codex login. A `morph-*` model calls Morph's free API directly, using the production prompt builders and reply decoder. The key comes from `MORPH_API_KEY`, or else from the `morph` provider in `~/.config/opencode/opencode.json`.

```sh
cd evals
pnpm conversation-summaries --model morph-kimik31 --arm main --samples 8 --out runs/peer-main
pnpm conversation-summaries --model morph-kimik31 --arm full --samples 8 --out runs/peer-full --baseline runs/peer-main/results.json
```

`--arm` sets how a peer reply reaches the model, so the arms compare from one checkout:

- `main` sends it as a nameless assistant message with no peer rule, as `main` does. Its leaf case fails by construction, because the name the grader wants is not in the input.
- `peer-as-user` renders it as a historical user message with the speaker in its header and no peer rule. This was the first attempt on `t3/peer-reply-summary-attribution`.
- `no-rule` names the peer but drops the prompt's peer rule.
- `full` is this checkout. It is the default and the only arm a `gpt-*` model can run, since the other arms edit the prompt.

Cases:

- `condensed-four-sources-retain-reversal-and-unverified-claim` passes when the roll-up keeps the later Postgres decision instead of the reversed Redis one, keeps the agent's test claim attributed and unverified, keeps the open rollback script, cites only the given summaries, and fits in 1,200 characters.
- `condensed-four-ordinary-sources` is the control: an ordinary docs task that must keep its open item and fit the same budget.
- `leaf-peer-proposal-is-not-a-user-decision` passes when the summary names Astra as the one who proposed Postgres, and credits that proposal to neither the user nor the agent.
- `leaf-ordinary-exchange-has-no-peer` is the leaf control: an ordinary docs task with no peer.
- `knowledge-peer-proposal-is-not-a-decision` passes when no `decision` candidate comes out of the same exchange, and no candidate states Postgres as settled.
- `knowledge-user-convention-is-kept` is its control: a plain user instruction must still become a fact.
- `--case <ids>` limits the run, and `--samples <n>` sets samples per case (default 3). A case fails when half or more of its samples fail. Read the statements in `results.json` as well as the automated result.

## Add a case

Add a condensed entry to `cases.ts` with an `id`, a `kind`, a `source`, the four child `summaries`, and the regex checks. A leaf or knowledge entry has `messages` instead of `summaries`. `run.test.ts` tests the grader.

## Cost

A `morph-*` sample is free but rate limited to about 24,000 uncached input tokens a minute; the runner waits out `Retry-After`. A `gpt-*` sample is one call on the local subscription. The CLI does not report per-call cost.
