# Commit workflow

Reproduces a logical-commit worker stopping because the optional `.t3code/commit-message.md`
was absent (reported November 2026). The control includes repository instructions and checks
that its subject prefix is followed. Each sample runs the actual workflow prompt through the
local Codex CLI in a disposable Git repository. Passing requires commits, the expected final
file contents, the original branch, and a clean worktree.

```sh
cd evals
pnpm commit-workflow --model <model> --out runs/commit-before
pnpm commit-workflow --model <model> --out runs/commit-after --baseline runs/commit-before/results.json
```

Uses the local Codex login. `--case missing-instructions` selects the regression; the other case
is `present-instructions`. Each case defaults to three samples; use `--samples 1` for a first
check. The baseline is validated as JSON and copied into the output directory. Inspect the
JSON results and retained CLI transcripts when a sample fails. A case fails when at least
half its samples fail. Compare against a baseline on the same model.

The CLI runs with approvals and sandboxing disabled so it can create temporary Git worktrees
and update fixture refs. Source files and worktrees are disposable; scratch work happens under
the system temporary directory. Do not put real project content in fixtures.

A full run makes six paid calls through the local subscription. The CLI does not report
per-call cost; the runner reports its call count. No real project or application state is used.
