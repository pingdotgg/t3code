# Performance regression checks

One benchmark per surface, a CI gate on wire size, and a startup profiler:

| Checks                 | Run                               | Source                                                                       |
| :--------------------- | :-------------------------------- | :--------------------------------------------------------------------------- |
| Server process         | `vp run report:server`            | [`scripts/metrics/server`](../../scripts/metrics/server)                     |
| Web client             | `vp run report:client`            | [`scripts/metrics/web`](../../scripts/metrics/web)                           |
| Mobile client          | `vp run mobile:metrics`           | [`scripts/metrics/mobile`](../../scripts/metrics/mobile)                     |
| Thread payload budgets | CI (`thread-transfer-report.yml`) | [`apps/server/integration`](../../apps/server/integration) `TransferBudget*` |
| Cold start             | `vp run profile:startup`          | [`scripts/profile-startup.mjs`](../../scripts/profile-startup.mjs)           |

Each benchmark takes `run`, `ab <checkoutA> <checkoutB>` and `compare`, and `--help` says what
each case measures. Isolated runs on a loaded machine say nothing: compare refs with `ab` on one
machine, which alternates them (A B, then B A) so drift lands on both sides.

[`scripts/metrics/core`](../../scripts/metrics/core) is what the benchmarks share: the alternating
rounds, the machine watcher that warns when other processes competed with a run, the bootstrap
comparison and A/A noise floors, the fake GitHub, and the 40-file branch the web and mobile runs
seed. A benchmark imports shared code from `core`, never from another benchmark.

## Wire and payload budgets

Payload budgets are enforced in
[`transferBudgetV2.integration.test.ts`](../../apps/server/integration/transferBudgetV2.integration.test.ts)
(whose opt-in objects are typed `Required` against contracts so new client opt-ins must be tested)
and reported on PRs by `TransferBudgetReport.integration.ts`. Run it, and the tests beside the code
you touch, whenever changing projection schemas, history paging, shell synchronization, or thread
state.

Core wire invariants:

- **Bounded windows.** Cold opens, history pages, and resume catch-ups enforce byte and row bounds
  before decoding full payloads, and exclude finished runs and duplicate message tables outside the
  active window.
- **No raw tool bodies on thread snapshots.** Raw command output, dynamic-tool result bodies, and
  inline file-change bodies are omitted at the wire boundary (diffs and explicit transcript exports
  fetch full data on demand).
- **Live command output bypasses orchestration events.** Adapters stream raw command output to
  [`CommandOutputHub`](../../apps/server/src/orchestration-v2/CommandOutputHub.ts) ahead of event
  ingestion, and clients subscribe only while a command row is expanded. Never route output deltas
  through `turn_item.updated`—a busy command would flood the event store and stall every thread.
- **Incremental shell sync.** Initial shells send active navigation rows only (omitting archived
  rows, idle subagents, and older settled threads), and resumes send deltas rather than full
  snapshots.

## Server process metrics

`report:server` measures server CPU, wakeups, RSS, heap, and first-request latency against a fake
Anthropic API and the real `claude` CLI:

- Use `scaling` to separate per-thread cost from fixed server overhead, and `--soak <minutes>` to
  spot rising heap slopes (leaks). A leak only shows in code the soak drives, so give a new
  subsystem with long-lived state a part in its workload.
- Steer server work by `working`: many worktree threads editing files at once with one client
  subscribed to all of them. Turns per minute that stay flat as threads are added mean the
  server, not the agents, is the bottleneck.
- Upper bounds no user hits daily, such as 20 clients reconnecting at once, run only with
  `--stress`; the default reconnect is a user's 3 devices holding 10 threads each.
- `--quick` shortens every window for a per-PR or nightly check; `compare` refuses to mix quick
  and full runs. `--help` says which scenario to trust for what.
- Test macOS, Windows, and Linux with `--no-agent-scope`: Linux systemd agent scopes mask
  per-process polling paths that other platforms run.

## Client switch metrics

`report:client` builds the web app for production, seeds a server with replayed threads (no paid
model), a large diff, a pull request on a fake GitHub and a local page, and drives headless Chromium
like a person. `--help` lists the cases and groups `--cases` takes. It launches Playwright's
Chromium headless shell, which installing dependencies does not download; install it once per
machine for the pinned `playwright-core` with `node scripts/node_modules/playwright-core/cli.js
install --only-shell chromium`.

- The harness, seed and replay agent come from the script, so an older checkout works as A; a case
  it cannot run is skipped and named. `compare` refuses files whose workload (cases, rounds, long
  thread length) differs, and takes each run's median as one sample: samples from one page are not
  independent, so it gates only with 2+ runs a side.
- **Switches** are sidebar clicks from a small hub thread. A case's first visit and its revisits
  are separate metrics, since a first visit is the thread's first open in that page. Paints under
  Event Timing's 16 ms threshold count as 16 ms.
- The Device surface has no device stream in the harness, so its case measures the empty state, not
  a streaming device. Panel cases also record the open surface's DOM size, which is deterministic;
  `*.census.json` in the artifacts says what dominates it.
- Memory (heap and DOM after GC) is sampled on load, after the first visits, and after every
  measured round has run, not per switch. Renderer CPU is sampled while the working thread streams
  its replayed turn; a window the turn ended before or during is skipped and named. `--soak <n>` repeats every
  case n times and fits heap, DOM and listener growth per iteration over the soak's later half. It
  runs in a second browser with V8's compiling tiers off: compiled code keeps growing for dozens of
  iterations as more functions get hot, which reads as a leak when it is only warm-up.

`--renders` counts React commits and component renders per step, the subtrees React bailed out
of not counted, with the top components and a cause per render (`mount`, `state#<hook slot>`,
`props:<changed keys>`, `parent-same-props<-Parent`, `context`). Counts barely move between runs,
so `compare` gates on them and they catch what timing noise hides. The probe slows commits, so
compare renders runs with renders runs. Names need `--unminified`; `--slot-diff A,B` diffs those
components' changed hook slots into `renders.ndjson`.

`--trace` traces one extra round with a CPU profile and maps it through the build's sourcemaps.
Per step, the task that ran its input splits into forced style and layout (top call sites at the
end) and JS: self time by package, then inclusive time by source file and by library, each counted
once per sample, since summing nested frames counts a library many times. Long tasks before the
step settled follow with their top sources. A keyboard shortcut usually renders in a later task,
so read its long tasks, not its input task.

`noise <ab dirs of one checkout against itself> --out floors.json` measures each metric's A/A
spread and writes a floor per metric, and which are too noisy to gate on; pass it to `compare` or
`ab` with `--floors`. Calibrate per machine; without floors, defaults apply.

## Mobile switch metrics

`mobile:metrics` is the mobile counterpart of `report:client`, built on [mobile:behavior](../../scripts/mobile-behavior/README.md)'s stack: a
Simlock iOS simulator, a server whose only provider is the scripted `evalbot`, a Metro serving the
checkout with the behavior probe, and the shared 40-file branch with its pull request on the
fake GitHub. Every step is a real tap, swipe or typed string through agent-device inside a
probe window that records the app's touches, React commits, the commit that first shows the target
thread's rows, composer keys, and JS and UI frames.

- The pool installs only the dev client. `--build dev` (default) runs the development bundle:
  commit and render counts (`--renders`) and A/B differences are representative, absolute times
  are not. `--build release` runs the production bundle as `hermesc -O` bytecode on that same
  client ([release-bytecode.ts](../../scripts/mobile-behavior/release-bytecode.ts)), with the
  probe kept by its env flag rather than `__DEV__`. It has no commit ms (React's profiling
  fields), no `--renders`, and minified component names in soak retention.
- `compare` gates like the web one: each app launch's median is one sample, so gate only with `--ab-rounds 2` or more, on one
  simulator model. `noise` calibrates floors from A/A runs.
- Latency counts from the touch's end as JS sees it, so a JS thread too busy to take the touch
  hides part of the delay. A tap on a native menu item (the Git controls' Review changes, the
  list switcher's Issues) never reaches JS as a touch, so it counts from the item's JS handler,
  which the shared `Menu` and native header menu report to the probe: later than the finger.
- A side chat is seeded with one exchange, since an empty one shows a placeholder rather than a
  timeline and would never count as content.
- `--soak <n>` repeats the switch cases and samples the Hermes heap after each one, with growth
  per iteration after warm-up and per case. Each sample follows a full Hermes `gc()`. Soak with
  `--build release`: the dev build grows about 5 MB an iteration with no leak, all of it the
  DevTools backend, the debugger-enabled Hermes keeping closure locals alive, react-refresh, and
  React's dev debug stacks.
- `settled` is the last commit before a second of quiet. Any streaming thread keeps Home
  committing, so only `switch-working` streams, and it stops its thread when done.

## Persistence and background work invariants

- Event-store sequence cursors and startup recovery candidate selection must seek indexes rather
  than scan retained history or decode completed threads just to discover no work remains.
- Trace and provider logs must use asynchronous, serialized writes and rotation—synchronous appends
  stall the server event loop on slow disks (especially Windows).
- Background awareness and settlement work must coalesce per thread and ignore high-frequency
  transcript/tool-output deltas.

## Mobile looping animations

`apps/mobile/package.json` enables Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` for iOS keyboard
avoidance without React Native's `preventShadowTreeCommitExhaustion`. Continuous Reanimated frames
(`withRepeat`) commit to the shadow tree every frame and can starve React's JS commits, freezing the
screen (or aborting in dev with `ShadowTree.cpp: assertion failed`). Use React Native's `Animated`
with `useNativeDriver: true` for looping animations that run beside heavy content (see
[`thread-work-log.tsx`](../../apps/mobile/src/features/threads/thread-work-log.tsx)).
