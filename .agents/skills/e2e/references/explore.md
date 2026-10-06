# Exploring without a test

`e2e explore` runs the agent against the app with a goal instead of a test
file: see what it can do with an app before tests exist, hunt for regressions
on a branch, or find what is worth turning into a test. It needs a config with
a target and an agent that holds a model, nothing else.

```bash
npx e2e explore   # goal: "Explore the app and find bugs"
npx e2e explore 'Explore checkout like a first-time buyer and report anything off'
npx e2e explore --target web --max-steps 4 --headed
npx e2e explore 'Hunt for broken forms' --video
npx e2e explore --session admin 'Explore the admin settings'
```

## What a run does

1. Opens the app on the target's URL.
2. Plans one step: a structured model call reads the goal, the steps and
   findings so far, and the current screen, and answers with a title and a
   concrete charter for one flow, or decides the goal is covered.
3. Runs the charter as an `agent.act()` step with the project's tools plus
   `report_finding`. The agent reports each defect the moment it has evidence:
   title, `issue` or `warning`, severity 1 to 5, expected, actual, reproduction
   steps. The runner adds the path and a redacted screenshot.
4. Repeats until the planner finishes, the step limit, the clock, or three
   failed or blocked steps in a row that reported nothing; then asks for a
   closing assessment.

A failed step does not end the run: it is recorded, and only reported issues
fail the product verdict. A run whose charters were all blocked stays blocked.
A step that hits its action or time budget ended at its limit and counts as
neither. Configured `credentials` reach the explorer as step secrets: the
planner knows the account names and usernames, and the agent fills passwords
with `type_secret` by name. That tool is offered only when the engine can fill
secrets; otherwise the agent skips signing in and says so in the step summary.

## Start signed in

`--session <name>` starts from a session a setup test saves
(`test.setup('...', { sessions: ['admin'] }, ...)` and `session.save('admin')`,
topic `writing-tests`). The run collects the config's test files, runs exactly
the setup that declares the session, then restores it into the exploration
and, on a target with a URL, opens the app, as a test with
`{ session: 'admin' }` does. No other test runs. The setup runs as for
`e2e run`, with the configured agents, cache, and retries; only the
exploration runs as the explorer. The planner and the agent are told they
start signed in, so no charter is spent signing in again. A name no setup
declares fails before any app process starts with `COLLECTION_ERROR`, naming
the declared sessions.

A setup that filled a secret taints the restored session, so every finding
goes without a screenshot; one that signed in without a fill (a `browser.setCookies`
session cookie, say) keeps them where the engine captures pixels, and only
configured secrets are redacted (topic `writing-tests`).

## Flags

| Flag                                                                                              | Default                         | Effect                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[goal]`                                                                                          | `Explore the app and find bugs` | One quoted sentence: the area and the posture.                                                                                                                                                                                                               |
| `--target <id>`                                                                                   | first configured target         | The one target to explore.                                                                                                                                                                                                                                   |
| `--agent <name>`                                                                                  | `default`                       | Build the explorer from another configured agent (`agents.<name>`).                                                                                                                                                                                          |
| `--session <name>`                                                                                | none                            | Run the setup that saves this session, then explore with it restored.                                                                                                                                                                                        |
| `--max-steps <n>`                                                                                 | 8 (1 to 12)                     | Exploration steps at most.                                                                                                                                                                                                                                   |
| `--timeout <ms>`                                                                                  | 600000 (180000 to 900000)       | Wall clock; the last minute is for the assessment.                                                                                                                                                                                                           |
| `--headed`, `--reporter`, `--output`, `--debug`, `--ai-trace`, `--trace [mode]`, `--video [mode]` | as `run`                        | Same meaning as for `e2e run`. One attempt, so a retry mode (`on-first-retry`, `on-all-retries`, the CI trace default) records nothing (`CI=1 e2e explore` needs `--trace on`; the run's notice says so); put the goal before a bare `--trace` or `--video`. |

Per-step action and model-call budgets default to 40 each;
`agents.<name>.maxSteps` and `agents.<name>.maxModelCalls` in the config
override them. The replay cache is off and retries are zero for the
exploration.

## Reading the result

Exit code `0`: steps ran, no `issue` was reported, and not every charter was
blocked; warnings are allowed. Exit code `1`: at least one `issue`, or no step
ran and nothing was found. If every charter was blocked and no `issue` was
reported, the run is `blocked` even with warnings, and the exit code is the
first blocker's own, as for `run`: 1 for an automation limit, 2 for a missing
model, credentials, seed data, or test setup, 3 for an unavailable
environment. When a charter passes, fails, or exhausts its budget, reported
issues decide the verdict. Other errors use `2` and `3` as for `run`.

The terminal shows each step by its title with its duration, actions, and
findings, and each finding the moment it is reported as
`⚑ high issue  Title (/path)`. At the end a `Findings` section lists every
finding, issues first and the most severe first, each with where it was seen,
its screenshot path, expected against actual, and the steps that reach it;
then the `Assessment` and the `run` summary with `Findings` and `Steps` in
place of `Test Files` and `Tests`. Severity words: critical 5, high 4,
medium 3, low 2, trivial 1. `.e2e/report.json` has the record under
`run.explore`:

```json
{
  "goal": "...",
  "budgets": { "maxSteps": 8, "timeoutMs": 600000 },
  "ended": "finished | step-limit | time | stuck | aborted",
  "summary": "the closing assessment",
  "steps": [
    {
      "index": 1,
      "title": "...",
      "instruction": "...",
      "status": "passed | failed | blocked | exhausted",
      "summary": "...",
      "errorCode": "...",
      "startedAt": "...",
      "durationMs": 0
    }
  ],
  "findings": [
    {
      "id": "<uuid>",
      "index": 0,
      "step": 1,
      "kind": "issue",
      "severity": 4,
      "title": "...",
      "expected": "...",
      "actual": "...",
      "reproduction": ["..."],
      "path": "/cart",
      "observationRevision": "...",
      "artifactId": "<attempt id>:artifact:2",
      "reportedAt": "..."
    }
  ]
}
```

A step carries `errorCode` only when it did not pass; a finding carries
`step`, `path`, `observationRevision`, and `artifactId` only when known.
`artifactId` names the evidence screenshot among the attempt's `artifacts` in
the result whose `file` is `explore`, where its path, size, and digest are.
With `--session`, `run.results` also holds the setup's result and the
project's other tests as skipped (`filtered`). The attempt directory is
`.e2e/artifacts/<target>/explore-<slug>-<digest>/<agent>/attempt-0/`: the slug
is the goal's first words in lowercase ASCII, capped, and the digest keeps
distinct goals apart while the same goal always maps to the same directory.
For example
`.e2e/artifacts/web/explore-check-the-cart-totals-1a2b3c4d5e6f7a8b/default/attempt-0/finding-1.png`.

Turn a finding into a test: its `reproduction` steps are the `agent.act()`
instructions or `screen.*` actions, and `expected` is the assertion.

## When it does not fit

The agents entry's `tools` and `system` carry over to the explorer; a
hand-rolled `StepExecutor` under `executor` is replaced by the built-in agent
for the run, with a notice on stderr, and needs a `model` on the entry (or the
executor's) or explore fails before it starts. Findings are the model's claims
plus evidence, not verified reproductions: read `actual` against the
screenshot before filing a bug.
