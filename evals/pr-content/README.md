# PR content

Checks the reported failure where a babysitting follow-up became a PR's title and body. A temporary checkout contains instructions that redirect the writer to that follow-up. The control case has no babysitting request. Both must describe the model retirement diff. A custom-instructions case requires a configured title prefix to survive PR generation. The additional-SQL case requires literal migration statements supplied as project-selected file context to appear in the body, guarding the reported omission of gitignored branch SQL.

```sh
cd evals
pnpm pr-content --model gpt-6-luna --out runs/pr-before
pnpm pr-content --model gpt-6-luna --out runs/pr-after --baseline runs/pr-before/results.json
```

Uses the local Codex login and the server's actual PR generator. Each case runs three times. `--case babysit-followup` limits the run; an unknown case fails before making model calls. Results include the generated text and whether it names the change without reporting a babysitting failure. A case fails when at least half its samples fail. Review the bodies for accuracy as well as the automated result.

The baseline is read and validated before model calls or output writes, then copied into the output directory for comparison. Runs use paid model calls through the local subscription, twelve calls for the full suite. The CLI does not expose per-call cost here.
