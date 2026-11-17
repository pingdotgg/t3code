# Memory standing check

Runs the production standing check against authored statements. Automatic memory saves every fact, but recalls only the ones this check calls standing and self-contained. The cases separate one task's limits, the behaviour of unmerged work and statements that do not name what they refer to (set aside) from a data-safety rule and a merge convention (kept).

```sh
cd evals
pnpm memory-standing-check --no-check --out runs/standing-before
pnpm memory-standing-check --model morph-kimik31 --concurrency 1 --out runs/standing-after
```

`--no-check` reproduces capture before the check: every proposed fact was recalled, so the set-aside cases fail. `--model gpt-6-luna` uses the local Codex subscription. Morph uses the free endpoint configured as described in [MCP tool use](../mcp-tool-use/README.md); it limits input tokens per minute, so keep `--concurrency 1`. Each sample is one call with one statement, so the default three samples make 18 calls. A case passes when a majority of its samples pass.

`results.json` holds each verdict. `--case <ids>` restricts cases and `--baseline` keeps an earlier results file beside the new one. These clear-cut cases guard against regressions; they do not estimate how often the check agrees with people on real facts.

Add a case with its source, the statement and its kind, and whether recall should keep it. Keep user data out of statements.
