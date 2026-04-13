# Performance Benchmarks

This repository has a local performance regression harness for the built web app and built server. It is intentionally separate from the normal unit and browser test suites.

The benchmark is meant to answer two questions:

- Does large-thread rendering and thread-to-thread navigation stay snappy?
- Does high-frequency websocket event application stay responsive under a realistic built-app flow?

## What it runs

The perf suite does not use Vite dev mode. Each run does this:

1. Seeds a real server base dir with deterministic fixture data using the normal event store and projection pipeline.
2. Starts the built `t3` server from `apps/server/dist/bin.mjs`.
3. Serves the built web bundle from `apps/server/dist/client`.
4. Launches Chromium with Playwright.
5. Installs an in-page collector for action timings, long tasks, `requestAnimationFrame` gaps, and mounted timeline row counts.
6. Writes a JSON artifact plus server stdout and stderr logs under `artifacts/perf/`.

The current implementation is browser-focused, but the harness already reserves a server sampling hook so later server-only CPU and memory benchmarks can share the same scenarios and artifact format.

## Main pieces

- `packages/shared/src/perf/scenarioCatalog.ts`
  - Shared scenario catalog for both seeded state and live provider traffic.
- `apps/server/integration/perf/seedPerfState.ts`
  - Creates the temporary sqlite-backed base dir using real orchestration events and projections.
- `apps/server/src/perf/PerfProviderAdapter.ts`
  - Perf-only mock provider that emits paced runtime events over the normal provider -> websocket -> client path.
- `apps/web/test/perf/appHarness.ts`
  - Starts the built app, launches Chromium, installs the browser collector, and writes artifacts.
- `test/perf/support/browserMetrics.ts`
  - Collects action durations, long tasks, `requestAnimationFrame` gaps, and mounted row samples inside the page.
- `test/perf/support/artifact.ts`
  - Defines the JSON artifact format and summary math.
- `test/perf/support/thresholds.ts`
  - Local budgets that currently gate the suite.
- `test/perf/support/serverSampler.ts`
  - Extension point for future CPU and memory sampling. The current implementation is `NoopServerSampler`, so `serverMetrics` is `null` today.

## Scenarios

### `large_threads`

Seeded app state used by the virtualization benchmark.

- 5 projects
- 30 threads total
- 2 heavy threads
- 1 burst thread
- 27 light filler threads spread across all projects

The two heavy threads currently seed:

- `84` and `96` turns
- `2,000` messages
- periodic worklog/activity rows
- periodic proposed-plan rows
- frequent checkpoint rows with larger changed-file trees

This keeps the thread count and project list closer to a real workspace mix: many projects, many sidebar rows, and heavy conversations that stay under `100` turns while still retaining thousands of messages because each turn fans out into multiple assistant messages. The heavy timelines also include the non-message rows that tend to stress grouping, virtualization, and diff-tree rendering.

### `burst_base`

Seeded app state used by the websocket benchmark.

- 1 burst target thread
- 1 navigation thread
- 1 filler thread

This smaller seed keeps the focus on live websocket application while still covering cross-thread background activity.

### `dense_assistant_stream`

Live provider scenario used by the websocket benchmark.

- runs for about `10` seconds
- spans `24` cycles
- updates `3` lanes at once: `burst`, `navigation`, and `filler`
- interleaves assistant messages with multiple worklog/tool lifecycles

Each cycle emits, per lane:

1. an assistant intro message
2. three worklog/tool command lifecycles with file payloads
3. an assistant followup message

The message fragments vary in length on purpose so the live stream does not render as uniformly sized chunks.

## What each benchmark asserts

### Virtualization benchmark

File: `apps/web/test/perf/virtualization.perf.test.ts`

This benchmark:

- opens the large-thread seed on the built app
- navigates between the two heavy threads through the real sidebar
- measures a warmup switch and then six measured thread switches
- samples mounted timeline row counts
- scrolls bottom -> top -> bottom to catch jank

It currently fails if the local budgets in `test/perf/support/thresholds.ts` are exceeded:

- max mounted timeline rows: `140`
- thread switch p50: `250ms`
- thread switch p95: `500ms`
- max long task: `120ms`
- max `requestAnimationFrame` gap: `120ms`

### Websocket benchmark

File: `apps/web/test/perf/websocket-application.perf.test.ts`

This benchmark:

- starts the built app with the perf provider enabled
- opens the burst thread
- sends one real composer message
- lets the mock provider emit the live multi-thread websocket burst
- switches to another thread during the burst and back again
- waits for the sentinel text that marks the end of the scenario

It currently fails if these budgets are exceeded:

- burst completion: `14,000ms`
- max long task: `120ms`
- long tasks over `50ms`: `2`
- max `requestAnimationFrame` gap: `120ms`
- burst-time thread switches: `500ms` max each

## Commands

### One-time browser setup

Install Chromium for the perf suite:

```bash
cd apps/web
bun run test:perf:install
```

### Run the full automated benchmark suite

From the repo root:

```bash
bun run test:perf:web
```

That command builds `@t3tools/web`, builds `t3`, and then runs the dedicated perf Vitest config.

### Re-run the perf suite without rebuilding

If the built artifacts already exist and you have not changed the built app since the last build:

```bash
cd apps/web
bun run test:perf
```

### Watch the automated run in a live browser

```bash
T3CODE_PERF_HEADFUL=1 bun run test:perf:web
```

If you already have fresh build artifacts:

```bash
cd apps/web
T3CODE_PERF_HEADFUL=1 bun run test:perf
```

### Open the seeded app manually for exploration

Large-thread virtualization state:

```bash
bun run perf:open:build -- --scenario large_threads --open
```

Websocket burst state:

```bash
bun run perf:open:build -- --scenario burst_base --provider dense_assistant_stream --open
```

If the app is already built, use the faster commands:

```bash
bun run perf:open -- --scenario large_threads --open
bun run perf:open -- --scenario burst_base --provider dense_assistant_stream --open
```

For the websocket scenario, open the burst thread and send one message to start the live stream.

### Inspect the seeded topology directly

The seed script prints the generated project and thread summaries as JSON:

```bash
bun run apps/server/scripts/seedPerfState.ts large_threads
bun run apps/server/scripts/seedPerfState.ts burst_base
```

## Artifacts

By default each run writes to:

```text
artifacts/perf/<suite>-<scenario>-<timestamp>/
```

Each run currently includes:

- `<suite>-<scenario>.json`
- `<suite>-<scenario>.server.stdout.log`
- `<suite>-<scenario>.server.stderr.log`

The JSON artifact contains:

- run metadata
- threshold profile
- summary metrics
- raw browser metrics
- `serverMetrics`, reserved for later server sampling

Current summary fields:

- `maxMountedTimelineRows`
- `threadSwitchP50Ms`
- `threadSwitchP95Ms`
- `maxLongTaskMs`
- `longTasksOver50Ms`
- `maxRafGapMs`
- `burstCompletionMs`

To change the artifact output directory for one run:

```bash
T3CODE_PERF_ARTIFACT_DIR=/tmp/t3-perf bun run test:perf:web
```

## Internal env vars

These are the perf-specific env vars in the current harness:

- `T3CODE_PERF_HEADFUL=1`
  - Launch Chromium headed instead of headless.
- `T3CODE_PERF_ARTIFACT_DIR=/path/to/output`
  - Override the artifact directory.
- `T3CODE_PERF_PROVIDER=1`
  - Enables the perf provider path on the server.
- `T3CODE_PERF_SCENARIO=dense_assistant_stream`
  - Selects the live perf provider scenario.

In normal usage, the automated harness and `perf:open` script set the provider env vars for you.

## Notes and limitations

- This is a local benchmark suite. It is not wired into CI yet.
- The normal `apps/web` test suite excludes `test/perf/**/*.perf.test.ts`. Perf tests only run through `apps/web/vitest.perf.config.ts`.
- The budgets are intentionally conservative first-pass tripwires, not tuned production SLOs.
- The current harness measures browser responsiveness only. Server sampling is an explicit extension point, not implemented metrics yet.
