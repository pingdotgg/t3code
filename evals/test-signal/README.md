# Test signal

Runs the Macroscope `test-signal` check ([`.macroscope/check-run-agents/test-signal.md`](../../.macroscope/check-run-agents/test-signal.md)) on real and synthetic test diffs, and checks that a cheap model flags low-signal tests and leaves good ones alone. Use it to cut the check to the fewest words that still work.

The model gets the check body, the PR's test diff, `read_file` and `grep` at the PR head, and `post_comment`. The wrapper prompt around the body is a stand-in for Macroscope's, which is not public.

## Run

```sh
cd evals
pnpm test-signal --out runs/baseline
pnpm test-signal --out runs/cut --prompt /path/to/variant.md --case new-table-row
```

- Models go through the `vibeproxy` CLIProxyAPI provider in `~/.codex/config.toml`. Default models: `gpt-6.1-terra` and `gpt-6-luna`. Pass `--model` once per model to change them.
- Flags: `--prompt <file>` (a variant of the check, default the real one), `--case <id>` (repeatable), `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (default 6), `--reasoning <level>` (default `low`, as the check runs).
- A bad case passes when a comment lands inside a target test. A guard case passes when the check posts nothing and replies exactly `All clear`.
- `summary.md` gives the prompt hash and word count, then per model: bad cases caught, guards clean, errors, and tokens.
- Cost: proxy quota only, about 0.5M tokens for a full run on both models.

## Add a case

Add an entry to `cases.ts`. A `real` case names a merged commit and its test paths. A `synthetic` case inserts one test after an anchor string in a real file. Bad cases list the titles of the tests to flag.
