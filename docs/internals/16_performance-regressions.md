# Performance regression checks

## Wire and payload budgets

```bash
vp run test:perf:v2-wire
```

Exercises real V2 projections and client reducers. Payload budgets are enforced in
[`transferBudgetV2.integration.test.ts`](../../apps/server/integration/transferBudgetV2.integration.test.ts)
(whose opt-in objects are typed `Required` against contracts so new client opt-ins must be tested)
and reported in CI via `TransferBudgetReport.integration.ts`. Run this whenever changing projection
schemas, history paging, shell synchronization, or thread state.

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

[`scripts/server-metrics.ts`](../../scripts/server-metrics.ts) benchmarks server CPU, wakeups, RSS,
heap, and first-request latency against a fake Anthropic API and the real `claude` CLI:

- Always compare refs with `ab <checkoutA> <checkoutB>` on the same machine rather than comparing
  isolated runs.
- Use `scaling` to separate per-thread cost from fixed server overhead, and `--soak <minutes>` to
  spot rising heap slopes (leaks). A leak only shows in code the soak drives, so give a new
  subsystem with long-lived state a part in its workload.
- Steer server work by `working`: many worktree threads editing files at once with one client
  subscribed to all of them. Turns per minute that stay flat as threads are added mean the
  server, not the agents, is the bottleneck.
- Upper bounds no user hits daily, such as 20 clients reconnecting at once, run only with
  `--stress`; the default reconnect is a user's 3 devices holding 10 threads each.
- `--quick` shortens every window for a per-PR or nightly check; `compare` refuses to mix quick
  and full runs. `server-metrics --help` says which scenario to trust for what.
- Test macOS, Windows, and Linux with `--no-agent-scope`: Linux systemd agent scopes mask
  per-process polling paths that other platforms run.

## Client switch metrics

[`scripts/client-metrics.ts`](../../scripts/client-metrics.ts) (`vp run report:client`) builds
the web app for production, seeds a server with replayed threads (no paid model), a large diff, a
pull request on a fake GitHub and a local page, and drives headless Chromium like a person.
`client-metrics --help` lists the cases and groups `--cases` takes. It launches Playwright's
Chromium headless shell, which installing dependencies does not download; install it once per
machine for the pinned `playwright-core` with
`node scripts/node_modules/playwright-core/cli.js install --only-shell chromium`.

- `run` measures one checkout; `ab <checkoutA> <checkoutB>` alternates them (A B, then B A) and
  `compare` gates the result. Isolated runs on a loaded machine say nothing; trust only `ab`. The
  harness, seed and replay agent come from the script, so an older checkout works as A; a case it
  cannot run is skipped and named. `compare` refuses files whose workload (cases, rounds, long
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
