# Commit workflow

Checks the structured planner used by logical commits. The model must assign each supplied change
ID exactly once, return commit messages, and honor repository writing instructions when provided.
The regression fixture has no optional `.t3code/commit-message.md`; the control supplies a subject
prefix. Source checkout contents, index, and HEAD must remain unchanged during text generation.
Git staging and commits are covered by the server's GitManager integration tests.

```sh
cd evals
pnpm commit-workflow --model <model> --out runs/commit-plans
```

Uses the actual Codex text-generation implementation and local login, with an isolated generation
folder and read-only execution. The model receives the supplied diff, not a task to manipulate Git.
`--case missing-instructions` or `--case present-instructions` selects one fixture. Each case defaults
to three samples; `--samples 1` runs a first check. JSON responses and per-sample grades are retained.
A case fails when at least half its samples fail. `--baseline` copies earlier JSON results for review;
compare only runs of the same planner and model.

A full run makes six paid calls through the local subscription. The CLI does not report per-call
cost; the runner reports the call count. Fixtures contain no real project or application state.
