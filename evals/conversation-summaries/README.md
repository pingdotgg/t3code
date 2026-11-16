# Conversation summaries

Checks the summary prompt on two inputs. A leaf is one exchange, including a reply from another model in the thread. A roll-up condenses four adjacent summaries, as the summary pass does for long threads. Each sample calls the server's real summary generator through the local Codex login, with the prompt from this checkout.

The production summarizer is an OpenCode model. This runner only builds a Codex text-generation client, so the runs here use `gpt-6-luna`.

```sh
cd evals
pnpm conversation-summaries --model gpt-6-luna --out runs/summaries-before
pnpm conversation-summaries --model gpt-6-luna --out runs/summaries-after --baseline runs/summaries-before/results.json
```

- `condensed-four-sources-retain-reversal-and-unverified-claim` passes when the roll-up keeps the later Postgres decision instead of the reversed Redis one, keeps the agent's test claim attributed and unverified, keeps the open rollback script, cites only the given summaries, and fits in 1,200 characters.
- `condensed-four-ordinary-sources` is the control: an ordinary docs task that must keep its open item and fit the same budget.
- `leaf-peer-proposal-is-not-a-user-decision` passes when the summary names Astra as the one who proposed Postgres, and does not record that proposal as a decision the user made.
- `leaf-ordinary-exchange-has-no-peer` is the leaf control: an ordinary docs task with no peer.
- `--case <ids>` limits the run, `--samples <n>` sets samples per case (default 3). A case fails when half or more of its samples fail. Read the statements in `results.json` as well as the automated result.

## Add a case

Add a condensed entry to `cases.ts` with an `id`, a `kind`, a `source`, the four child `summaries`, and the regex checks. A leaf entry has `messages` instead of `summaries`. `run.test.ts` tests the grader.

## Cost

Each sample is one paid call through the local subscription. The full suite is twelve calls: six roll-up samples and six leaf samples. The CLI does not report per-call cost here.
