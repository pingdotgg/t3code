# Workflow authoring

Checks that a model can write a working workflow definitions file from the
[`t3-workflows` skill](../../skills/t3-workflows/SKILL.md) alone. Run it when the skill, the author
API, or the way the server loads a definitions file changes.

The model gets the skill's body and one task, and replies with a file. The grader loads that file
with the server's loader, registers it in the real engine on a throwaway database, and drives it
with a stand-in for agents: it starts runs, delivers webhooks, answers questions, restarts the
engine, and checks how each run ends. Nothing is judged by reading the code.

## Run

```sh
cd evals
pnpm workflow-authoring --out runs/baseline
pnpm workflow-authoring --out runs/shorter --skill /path/to/variant.md --baseline runs/baseline/results.ndjson
```

- Models go through the `vibeproxy` CLIProxyAPI provider in `~/.codex/config.toml`. Default models:
  `gpt-6.1-terra` and `gpt-6-luna`. Pass `--model` once per model to change them.
- Flags: `--skill <file>` (a variant of the skill), `--case <id>` (repeatable), `--samples <n>`
  (default 3), `--reasoning <level>` (default `low`), `--baseline <results.ndjson>`.
- Each answer is saved next to the results as `<case>.<model>.<sample>.ts`, and `summary.md` lists
  every problem the grader found.
- Cost: proxy quota only, about 5,000 tokens per sample.

The answers are code the grader runs. They come from a model that saw only the skill and the task,
but run this on a machine where that is acceptable.

## Add a case

Add an entry to `cases.ts`: the task as a person would give it, and one or more scenarios. A
scenario says what the stand-in agent answers and returns the problems it finds after driving the
file's workflows; none is a pass. Put a reference answer in `fixtures/<case id>.ts`, which
`run.test.ts` requires to pass, and a wrong answer when the case exists to catch one mistake.
