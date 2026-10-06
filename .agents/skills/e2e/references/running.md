# Running tests

## Commands

```bash
npx e2e run [files...] [options]   # run tests
npx e2e explore [goal] [options]   # explore toward a goal without a test file (topic explore)
npx e2e list [files...] [options]  # print what run would select
npx e2e init [directory] [--yes]   # scaffold a project, refresh the agent skill
npx e2e guide [topic]              # print this skill; topics: setup, writing-tests, agent,
                                   # running, explore, debugging, mcp, bug-bash
npx e2e cache ls|clear|stats       # inspect or empty the replay cache
npx e2e login|logout|models [provider]  # e2e/oauth subscription logins: openai,
                                   # github-copilot, opencode-console, spacexai
npx e2e mcp [--target <name>]      # MCP server for a coding agent (topic mcp)
npx e2e feedback -m <text> [opts]  # report a problem with e2e itself
npx e2e telemetry [disable|enable] # anonymous usage telemetry: status or switch
```

`run` flags:

| Flag                                          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[files...]`                                  | Files, directories, quoted globs relative to the project root, or a bare name (`signup`, `signup.e2e.ts`, `agent/signup.e2e.ts` all select `tests/agent/signup.e2e.ts`); `file:line` is the test whose `test(` opens on that line. They narrow the config `tests` glob, never bypass it.                                                                                                                                                                                                                |
| `--config <path>`                             | Config file; default `e2e.config.ts` or `.mts`, found upward.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--target <ids>`                              | Target names, comma-separated or repeated; only these start their app commands. Unknown names fail before startup.                                                                                                                                                                                                                                                                                                                                                                                      |
| `--tag <tags>`                                | Any of the tags, comma-separated or repeated; all of them with `--tag-mode all`. An empty `--target`, `--tag`, or `--agent` value is a usage error, exit 2.                                                                                                                                                                                                                                                                                                                                             |
| `--exclude-tag <tags>`                        | Drop tests carrying any of these tags, however selected.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--grep <pattern>`, `--grep-invert <pattern>` | Keep, or drop, tests whose title (describe titles and test title joined by spaces, `checkout pays`; not file or tags) matches a regular expression. Bare pattern or `'/pattern/i'`; repeat for alternatives.                                                                                                                                                                                                                                                                                            |
| `--last-failed`                               | The tests the previous run (`<output>/report.json`) did not pass or never ran (`--max-failures` included), plus every test in a failed `beforeAll` or `afterAll` scope. A test another filter leaves out stays owed (`run.carried` in the report) until a rerun runs it. No report is `NO_LAST_RUN`, exit 2.                                                                                                                                                                                            |
| `--shard <index/total>`                       | One contiguous slice of the selected tests (`--shard 2/3`), cut after every other filter; serial groups stay whole, each shard brings its own setup tests.                                                                                                                                                                                                                                                                                                                                              |
| `--headed`                                    | Visible browser or simulator when the engine supports it.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--agent <names>`                             | Run unpinned tests as these `agents.<name>` entries (default `agents.default`), comma-separated or repeated; several names run each such test once per agent.                                                                                                                                                                                                                                                                                                                                           |
| `--workers <n>`, `--retries <n>`              | Override the resolved values; retries 0-10, workers 1-1024.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--max-failures <n>`                          | Stop after n failures: the rest skip (cause `failure-limit`), running tests end `interrupted`; exit 1.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--repeat-each <n>`                           | Run every selected test n times, each run its own result (`repeat` 0 through n-1); add `--no-cache` or later runs replay the first's recording. The `Repeats` summary row names each unstable test's failed runs.                                                                                                                                                                                                                                                                                       |
| `--reporter <ids>`                            | `list`, `json`, `junit`, `markdown`, comma-separated; `json` cannot combine with `list`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--output <dir>`                              | Results directory, over the config's `output` (default `.e2e`).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--no-cache`                                  | Replay cache off for this run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--strict-cache`                              | Fail a step whose committed recording no longer replays (`REPLAY_STALE`, exit 2) instead of handing it to the agent.                                                                                                                                                                                                                                                                                                                                                                                    |
| `--pass-with-no-tests`                        | Exit 0, not `NO_TESTS`, when nothing matches.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--debug`                                     | Phase timings and an agent step table on stderr; transcripts as artifacts.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--ai-trace`                                  | Every model call, to `<output>/ai-trace.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--trace [mode]`, `--video [mode]`            | Which attempts record a trace, or a video (WebM on browsers, MP4 on devices), over the config and every target: bare is `on`; `--trace off` skips the cost; `retain-on-failure` (video) keeps only failed attempts; `on-first-retry` records first retries, `on-all-retries` every retry. A test's own `trace` or `video` still wins; targets whose engine cannot record are skipped with a notice. Both are greedy: write `--video=<mode>` or put test files first. The failure recap names the video. |

```bash
npx e2e run tests/signup.e2e.ts
npx e2e run signup.e2e.ts:12   # by bare name, the test declared at line 12
npx e2e run tests/agent --tag smoke --exclude-tag slow --grep checkout
npx e2e run --last-failed   # the loop after a red run
npx e2e run --shard 2/3     # one CI job of three
npx e2e run 'tests/**/*.smoke.e2e.ts' --target chromium --workers 1 --retries 0
CI=1 npx e2e run            # the CI defaults, locally
```

`list` takes the same files and selection flags (`--config`, `--target`,
`--tag`, `--tag-mode`, `--exclude-tag`, `--grep`, `--grep-invert`,
`--last-failed`, `--shard`, `--pass-with-no-tests`), prints one line per
test-target pair, `file › title [target] #tag`, skipped pairs ending in
` (skipped: <reason>)`, and starts no app, engine, or worker.
`--reporter json` prints `{ "pairs": [...] }`.

```bash
npx e2e list tests/signup.e2e.ts --tag smoke --reporter json
```

With a `package.json` script `"test:e2e": "e2e run"`, pnpm forwards `--`
literally: `pnpm test:e2e -- --headed` reaches e2e as `run -- --headed` and
exits 2. Write `pnpm test:e2e --headed` or `pnpm exec e2e run --headed`.

## The replay cache

Entries live under `.e2e/cache/`, one file per key, named by key digest.
`cache` commands read the same config as `run` (`--config`, `cache.dir`);
with a custom `cache.store` they refuse (exit 2), inspect that store with
its own tools.

| Command           | Prints                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `e2e cache ls`    | One row per entry: test, target, instruction digest, age, action count.   |
| `e2e cache stats` | Directory, entry count, total size.                                       |
| `e2e cache clear` | Deletes the entries and the directory; files the runner never wrote stay. |

## Output

`<output>` (`.e2e` by default) holds `report.json`, `junit.xml`,
`summary.md`, `failures/`, `ai-trace.json`, `sessions/`, and `artifacts/`
(screenshots, Playwright traces, videos, `--debug` transcripts, downloads).
`artifacts/` is cleared once a run's tests start; a run stopping before
leaves the last run's files, and a `--last-failed` rerun keeps the files
the report it reruns names and writes its own under `artifacts/rerun-<n>/`. The report records every artifact path, a
hosted service's video by URL.

- `list` (default): setup steps, one line per file and target, a `Failed
Tests` section (error, code, failing line, code frame), then the
  summary rows `Test Files`, `Tests`, `AI`, `Cache` (when the replay cache
  ran), `Repeats` (with `--repeat-each`), `Errors`, `Start at`, `Duration`,
  `Report`, `AI trace` (with `--ai-trace`). Past a minute `Duration`
  repeats as minutes and seconds, setup time split out as `startup` in the
  same parenthetical (`682.97s (11m 23s, startup 43.00s)`).
- `report.json`, written whatever the reporters, holds `run.status`,
  `run.exitCode`, `run.errors[]` (run-level, such as `APP_UNREACHABLE`),
  and `run.results[]`, one per test and target: `titlePath`, `file`,
  `source`, `tags` (`[]` when none), `agent`, `repeat` (0 unless
  `--repeat-each`), `selected`, `status`, `attempts[]` of `steps[]`,
  `artifacts[]`, `error`. `run.summary` counts the selected results:
  `passed`, `failed` (timed out included), `interrupted` (stopped by the
  run: a signal, `--max-failures`, a run-level error; not a failure), `flaky`, and `skipped` add up
  to `selected`; `discovered - selected` were left out.
- `junit`: `junit.xml` for CI summaries; `--reporter list,junit` keeps the
  terminal output.
- `markdown` (`--reporter list,markdown`): `summary.md` plus one page per
  failed or flaky test under `failures/` (an interrupted test gets none). The summary holds counts and
  spend, a block per failed test (error, facts, failing step, whether every
  attempt failed alike, last model turns, screen location and closest
  nodes, the line to look at, evidence paths), the flaky tests folded
  alike, and every test as one folded table, a row per file (or an
  exploration's findings and assessment); a failure page adds every step,
  every kept turn, and the screen at failure inline. Read the page first;
  paste the summary into a pull request or handoff.
- `json`: the report on stdout.
- Custom reporters get step progress with `identity` (`attemptId`,
  `attemptIndex`, `stepId`, `stepIndex`: report IDs, zero-based indexes;
  retries change the attempt, serial members share the group's attempt with
  distinct step IDs) and an `end` phase carrying the redacted error and the
  `blocked` and `cancelled` statuses. Older streams may lack `identity`.
- `github()` from `@e2e-dev/github`: on GitHub Actions, one pull request
  comment per run (edited on rerun) plus the job summary; needs
  `pull-requests: write` and `GITHUB_TOKEN` (or `GH_TOKEN`) in the step's
  env.

## Exit codes

| Code | Meaning                                                            |
| ---: | ------------------------------------------------------------------ |
|    0 | Every selected test passed, was flaky, or was skipped              |
|    1 | A test or setup test failed or timed out                           |
|    2 | CLI, config, collection, credential, model-config, or policy error |
|    3 | Engine, app process, model provider, artifact, or cleanup failure  |
|    4 | Internal runner error                                              |
|  130 | Interrupted by an external signal                                  |

The highest code present wins (`130 > 4 > 3 > 2 > 1 > 0`). 130 needs an
external signal: a `--max-failures` stop or a run-level error that
interrupted workers keeps the failures' or the error's code. Exit 2 is
deterministic, never retry it; only exit 3 is worth a job-level retry.

The first SIGINT or SIGTERM interrupts and writes the report if any test
had started; the second forces engine teardown and still writes the
report, plus `junit.xml` and `summary.md` when those reporters are on; the
third kills the app process groups and exits 130 at once.

## Continuous integration

CI mode is on when `CI` is set (not `0` or `false`): `retries` 1,
`workers` 1, `trace` `on-first-retry`, `test.only` rejected with
`ONLY_IN_CI`, the replay cache `read-only` unless the config sets a mode explicitly
(`cache: 'read-write'` or `cache.mode`), `reuseExisting` ignored.

```yaml
# .github/workflows/e2e.yml
# Omits the github() reporter: it needs pull-requests: write and
# GITHUB_TOKEN in the run step's env.
name: e2e
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: pnpm/action-setup@9fd676a19091d4595eefd76e4bd31c97133911f1 # v4.2.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 26 # any Node >= 22.12
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec e2e-web install chromium --with-deps
      - run: npx e2e run --reporter list,junit
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
          E2E_USER_ADMIN_USERNAME: ${{ secrets.E2E_USER_ADMIN_USERNAME }}
          E2E_USER_ADMIN_PASSWORD: ${{ secrets.E2E_USER_ADMIN_PASSWORD }}
      - if: ${{ !cancelled() }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: e2e-report
          path: |
            .e2e/report.json
            .e2e/junit.xml
          if-no-files-found: warn
      - if: ${{ !cancelled() }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: e2e-artifacts
          path: .e2e/artifacts
          if-no-files-found: warn
          retention-days: 7
```

- Install browsers as their own step so the download stays out of the
  launch timeout.
- Upload artifacts unless cancelled, so a test that failed then passed on
  retry keeps its evidence.
- Start the app through the target's `app.command`; the runner tears it down
  on every exit path.
- Agent steps run in the same job: pass the key the config's model reads
  (`AI_GATEWAY_API_KEY` for `gateway()` from `ai`) as a secret in the run
  step's `env`, and commit `.e2e/cache/` so recorded steps replay with no
  model call.
