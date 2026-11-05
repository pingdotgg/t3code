# Blind model outcome judgments

Checks whether the production judge distinguishes recorded failures from success claims, ignores
scoring instructions embedded in tool evidence, respects a planning-only task, and abstains when
essential artifacts are missing. All cases are synthetic and contain no user conversations.

The runner imports the production prompt builder and verdict validator. Real runs call
`makeClaudeTextGeneration().generateModelEvaluation`, including its isolated working directory,
safe mode, and disabled tools. It does not simulate the judge or copy the prompt.

## Run

From `evals/`:

```sh
pnpm model-evaluations --dry-run --out runs/judge-inputs
pnpm model-evaluations --model haiku --case failed-test-beats-success-claim --samples 1 --out runs/judge-check
pnpm model-evaluations --model haiku --samples 3 --out runs/judge-baseline
pnpm model-evaluations --model haiku --samples 3 --baseline runs/judge-baseline/results.json --out runs/judge-candidate
```

`--dry-run` validates every selected packet and writes only `prompts.json`, with **zero model calls**.
It neither creates a provider client nor produces scored results. Use a new output directory to keep
dry-run prompts separate from any earlier results. Real runs require an installed,
authenticated Claude CLI that supports `--safe-mode`. `--model` defaults to the CLI's `haiku` alias;
use `sonnet` or a configured Claude model ID to compare another judge.

`--case` accepts repeated flags or comma-separated IDs. `--samples` is 1–20 and defaults to 3.
The four-case default is 12 sequential model calls. The cost follows the configured account; this
generation operation does not return token usage or dollar cost, so the summary records those as
unknown for real runs. A dry run costs $0. CI runs only the deterministic grader tests.

## Results

Real runs write `prompts.json`, `results.json`, and `summary.md`.
Raw structured verdicts and failure reasons remain inspectable. Call errors count as failed
samples. A case passes only if more than half its samples pass; a tie fails. A real run exits with
status 1 if any case fails.

Baseline comparison requires the same model, packet, and grader hashes. It deliberately allows
the production prompt hash to change. Read the raw verdicts too: these guards catch particular
mistakes and do not establish that an evaluator is accurate for every task.

## Add a case

Add a packet with an ID and source explanation in `cases.ts`, then add its behavioral checks in
`grade.ts` and paired accepted/rejected examples in `run.test.ts`. Include a control where ordinary
successful work should be accepted. Keep assertions about observable outcomes; do not require a
specific wording from the judge.
