# Project icon

Checks that the project icon picker returns a usable Lucide icon name and a known project color. Each case runs three times. The websocket-server case must name the backend domain; the mobile-notes and empty-project cases are controls that must still return valid names and colors.

```sh
cd evals
pnpm project-icon --model gpt-6-luna --out runs/icon-before
pnpm project-icon --model gpt-6-luna --out runs/icon-after --baseline runs/icon-before/results.json
```

Uses the local Codex login and the server's actual project icon generator. `--case websocket-server` limits the run; an unknown case fails before making model calls. Results include the generated name and color plus whether they pass the grader. A case fails when at least half its samples fail. Review the names for domain fit as well as the automated result.

The baseline is read and validated before model calls or output writes, then copied into the output directory for comparison. Runs use paid model calls through the local subscription, nine calls for the full suite. The CLI does not expose per-call cost here.

## Add a case

Add an entry to `run.ts` with an `id`, a `source`, the project title, up to three thread titles, top-level entries, and README or package.json excerpts. The grader only checks name shape and color membership, so name the domain fit you expect in the source or a comment.
