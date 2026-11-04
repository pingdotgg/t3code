# Session recaps

Runs the production tool-free Claude text generator against synthetic recent-message excerpts. Review the output against each case's rubric: accuracy, no invented progress, and no invented next action. It uses the local Claude login and incurs normal model usage.

From `evals/`, start with `pnpm session-recaps --out runs/recap-smoke --case no-next-action --samples 1`. Then run `pnpm session-recaps --out runs/recaps --samples 3`. Haiku is the default; `--model` selects another configured Claude model.

Results include the source excerpts, rubric, and each response. A case passes when more than half its samples satisfy the rubric. Use `--baseline <previous results.json>` to include earlier results for comparison on the same model. Add cases in `cases.ts`; the runner imports the production generator and prompt instead of copying them.
