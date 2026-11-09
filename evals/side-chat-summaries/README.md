# Side-chat summaries

This eval asks the real opening-summary prompt to summarize two authored lesson shapes and the outcome-note prompt to report a learner's question faithfully. It checks that the learner's state leads, the summary stays short and ends cleanly, and a Haiku judge can find the long case's specific confusion near the start or reject a note that invents a misconception.

The cases cite `~/t3-learn-notes/context-management/lesson.md` near line 969, where the 63% cap finding was recorded. They contain no user data.

Run from `evals/`:

```sh
pnpm side-chat-summaries --dry-run --out runs/dry --case long-learner-confusion
pnpm side-chat-summaries --dry-run --out runs/dry --case short-control
pnpm side-chat-summaries --dry-run --out runs/dry --case r8-deduction-limit-question
pnpm side-chat-summaries --out runs/summaries --samples 3 --model claude-haiku-4-5
pnpm side-chat-summaries --out runs/outcome --samples 3 --model claude-haiku-5-5 --proxy pool --case r8-deduction-limit-question
```

`--out` is required. `--case` selects a case, `--samples` defaults to 3, `--model` defaults to `claude-haiku-4-5`, and `--baseline <results.json>` records the earlier pass count beside the new one. `--dry-run` prints the writer and judge request bodies and needs no API key. Live runs read `ANTHROPIC_API_KEY` from the repo-root `.env`; when it is absent, pass `--proxy pool` to use the shared provider pool without printing or handling a key. Production outcome notes use the lesson provider's small text model; for Claude that is `claude-haiku-5-5`, so use that model for outcome-note runs when the pool supports it.

Each case fails when at least half its samples fail. A sample must be at most 1,800 characters, end in a complete sentence, and pass the learner-first Haiku rubric. Opening-summary runs default to Claude Haiku 4.5; outcome-note runs should use Claude Haiku 5.5 to match production. Three samples per case cost roughly a few cents, depending on the lesson context.

To add a case, add an authored, commit-safe lesson message array and its source citation to `cases.ts`, then give it a rubric that can be answered YES or NO from one summary.
