# Resource telemetry architecture

Status: implemented

## Purpose

Resource telemetry replaces recurring `ps`, PowerShell, `ioreg`, and `pmset`
subprocess probes with two persistent, direct data sources:

1. a standalone Rust resource-monitor executable that reads process counters
   through operating-system APIs via `sysinfo`;
2. Electron main-process APIs for Electron process metrics and host power state.

The native monitor owns bounded in-memory history. The server only merges and
summarizes that history when diagnostics requests it. Telemetry history is not
persisted to disk or continuously copied into Node.

## Why a standalone executable

The monitor is intentionally not a Node native addon.

- No N-API, `ffi-rs`, or dynamic-library ABI is loaded into the server process.
- A monitor crash cannot corrupt the Node runtime.
- The server can supervise, restart, version-check, and measure the monitor as a
  normal child process.
- The same protocol works for the desktop app and the published CLI.
- Packaging is a single platform executable instead of an addon toolchain plus
  Node/Electron ABI matrix.

The cost is one persistent child process and NDJSON serialization. That is a
better failure boundary than repeatedly spawning shell utilities or loading
native code into Node.

## Runtime topology

### Desktop

```text
Electron main
  ├─ powerMonitor
  ├─ app.getAppMetrics() while diagnostics is open
  ├─ inherited fd 4, telemetry NDJSON ─────────────┐
  └─ inherited fd 5, demand-control NDJSON ◀──────┤
                                                   ▼
Node server ── stdin/stdout NDJSON ── Rust resource monitor
     │
     ├─ ResourceTelemetry Effect service
     ├─ background power policy projection
     └─ WebSocket RPC/subscription ── diagnostics UI
```

### Web, headless, and remote server

Electron telemetry is unavailable. The native monitor still runs beside the
server and tracks the server process tree. Power fields degrade to `unknown`
instead of invoking platform shell commands.

## Native monitor

The executable lives in `native/resource-monitor`.

It receives schema-compatible commands on stdin and emits one JSON object per
line on stdout:

- `configure`
- `setExternalProcesses`
- `setSampleInterval`
- `setStreaming`
- `sampleNow`
- `readHistory`
- `shutdown`
- `hello`
- `snapshot`
- `historyChunk`
- `error`

The protocol version is defined by
`RESOURCE_MONITOR_PROTOCOL_VERSION` in
`packages/contracts/src/resourceTelemetry.ts`.

### Collection

The monitor keeps one `sysinfo::System` instance and refreshes it at the
power-adaptive interval selected by the server. It collects:

- PID and parent PID;
- process start time and run time;
- process name and command line;
- current and cumulative CPU usage;
- resident and virtual memory;
- cumulative process I/O counters.

On Linux, task/thread enumeration is disabled. Command lines are loaded only
when first needed. This avoids the expensive default behavior of walking every
`/proc/<pid>/task/<tid>` directory on each refresh.

### Process-tree selection

Each sample scans the accessible process table, builds the PID/PPID graph, and
retains:

- the server process;
- every descendant of the server, including provider-spawned grandchildren such
  as shells, `node`, `tsgo`, language servers, and other tools;
- Electron processes supplied as explicit external roots;
- descendants of those Electron roots;
- the resource monitor itself, because it is a server child.

Process identity is `(pid, startTimeMs)`, not PID alone. Electron and native
start times are matched with a two-second tolerance because native start times
can have coarser platform resolution.

The process list is emitted in depth-first tree order so renderer collapse and
expansion preserves complete subtrees.

### Native history and streaming

Every native sample is appended to a one-hour in-memory ring bounded to 3,600
snapshots and 20,000 retained process rows. History stays in the sidecar until a
`readHistory` request and is returned in bounded chunks. The first bound reached
wins, so high process counts shorten the effective history window.

Periodic snapshot streaming is disabled by default. The server enables it only
while at least one diagnostics subscription is retained. `sampleNow` remains
available for explicit refreshes and identity validation.

The server adjusts native sampling without restarting the sidecar:

- suspended: paused;
- locked, low-power, or serious/critical thermal state: 15 seconds;
- battery: 5 seconds;
- normal AC: 1 second;
- unknown or stale power: 5 seconds in the background and 1 second while live
  diagnostics is open.

### Sampling limits

This is counter sampling, not syscall tracing.

- A process that starts and exits entirely between samples may not be observed.
- Cumulative CPU and I/O counters still provide accurate deltas for processes
  that survive across samples.
- Exact file paths, individual write syscalls, ETW events, eBPF events, and
  Endpoint Security events are outside this implementation.

Those deeper tracing systems can be added later as opt-in diagnostic modes
without changing the public `ResourceTelemetry` model.

## I/O semantics

The monitor preserves platform semantics instead of presenting all counters as
equivalent:

- Unix-like platforms report storage I/O counters exposed by `sysinfo`.
- Windows reports all process I/O bytes, not only disk bytes.
- Operating-system caches can prevent logical application reads or writes from
  appearing as physical storage bytes.

The UI therefore labels these values as I/O reads and writes and exposes the
per-process `ioSemantics` value.

Group totals are observed deltas since telemetry startup. Per-process total
columns are the operating system's cumulative counters for that process.

## Electron telemetry

Electron main owns `DesktopTelemetryPublisher`.

Power events trigger an immediate snapshot. A low-rate 30-second heartbeat keeps
the server-side power state fresh while diagnostics is closed. During that
heartbeat Electron reads:

- `powerMonitor.isOnBatteryPower()`;
- `powerMonitor.getSystemIdleTime()`;
- `powerMonitor.getSystemIdleState()`;
- `powerMonitor.getCurrentThermalState()`.

`app.getAppMetrics()` is only called while diagnostics demand is active. Its
live cadence is 1 second on AC, 5 seconds on battery, and 15 seconds while
locked, suspended, or thermally constrained.

It also listens for:

- lock and unlock;
- suspend and resume;
- AC and battery transitions;
- thermal-state changes;
- CPU speed-limit changes.

Electron does not expose a cross-platform low-power-mode getter, so that field
remains `unknown`.

The desktop backend is spawned with:

- fd 3 for the existing bootstrap payload;
- fd 4 for Electron-to-server telemetry NDJSON;
- fd 5 for server-to-Electron diagnostics-demand NDJSON.

These are private Electron-main/server pipes. They do not use the renderer
WebSocket and are recreated for every backend restart.

## Server Effect services

The implementation is under `apps/server/src/resourceTelemetry`.

### `ResourceMonitorBinary`

Resolves an executable from:

1. `T3CODE_RESOURCE_MONITOR_PATH`;
2. desktop bootstrap configuration;
3. bundled CLI resources;
4. local Cargo build outputs.

Unsupported platforms, missing binaries, and non-executable binaries use
schema-backed tagged errors with descriptive messages.

### `NativeTelemetryClient`

Owns the resource-monitor process and protocol.

- validates the hello/version handshake;
- sends configuration and external process roots;
- adapts the native interval from host power state;
- enables streaming only for scoped live subscribers;
- reads chunked native history on demand;
- exposes `sampleNow`;
- serializes commands;
- supervises process exit and protocol failure;
- restarts with bounded exponential backoff;
- opens a circuit after repeated failures;
- supports explicit retry;
- publishes health changes immediately.

Snapshot sequence numbers are scoped to a monitor generation. Server ingestion
uses the monitor restart count as the generation key, so sequence reset after a
restart cannot freeze telemetry.

### `DesktopTelemetryReceiver`

Reads fd 4, decodes schema-validated messages, stores the latest Electron
snapshot, and publishes desktop health. It writes diagnostics demand to fd 5
and marks the source stale after 90 seconds without a heartbeat. Decode errors,
protocol mismatch, control-write failure, stream failure, stale input, and
normal stream closure are represented explicitly.

### `ResourceTelemetry`

Merges native and Electron data and owns public telemetry semantics.

- calculates CPU and I/O rates from cumulative native counters;
- preserves the last native rates during desktop-only updates;
- classifies backend, Electron, and monitor processes;
- computes process depth and child relationships;
- tracks starts, exits, CPU time, and observed I/O;
- projects power data;
- acquires native streaming and Electron process metrics only for scoped live
  subscribers;
- queries and replays native history only when requested;
- validates `(pid, startTimeMs)` before process signaling;
- updates history health even when no further native sample arrives.

Electron and monitor processes are visible but are not valid targets for the
existing process-signal RPC.

### History projection

`ResourceTelemetryHistory` is a pure on-demand projection. It replays raw native
snapshots to derive rates, lifecycle counters, buckets, and process summaries.
Current Electron process metrics are intentionally excluded from historical
replay so they cannot overwrite older native CPU or memory samples.

### `ResourceAttribution`

Tracks known logical application I/O separately from OS counters. Current
integration points record successful writes for:

- provider native and canonical event logs;
- the local server trace sink.

Entries contain component, operation, logical bytes, count, and elapsed time.
Future persistence paths should call `ResourceAttribution.record` rather than
adding diagnostics-specific counters.

## Background policy integration

`HostPowerMonitor` consumes `DesktopTelemetryReceiver` directly; observing host
power does not retain live resource diagnostics or invoke shell probes.

The monitor updates its latest timestamp on every Electron sample but only
publishes semantic state changes. Increasing idle seconds alone does not cause a
background-policy broadcast every second.

## Public API and UI

The WebSocket RPC surface provides:

- current snapshot;
- bounded history;
- explicit monitor retry;
- a live snapshot subscription.

The diagnostics page displays:

- aggregate CPU, memory, I/O, and process counts;
- backend, Electron, and monitor overhead groups;
- power and thermal state;
- collector health and restart information;
- CPU and I/O history;
- a collapsible live process tree;
- safe process signaling for backend descendants;
- instrumented logical application I/O.

Legacy process diagnostics RPCs are projected from the same service so they no
longer start recurring process-table commands.

## Packaging

Desktop artifact builds compile the Rust target, stage it as
`resources/resource-monitor/t3-resource-monitor[.exe]`, and pass its path to the
backend bootstrap.

CLI release jobs upload each active platform monitor artifact and copy it into:

```text
apps/server/dist/resource-monitor/<platform>-<arch>/
```

The published server package already includes `dist`, so those executables ship
with the CLI. Missing platform artifacts degrade native telemetry to
`unavailable`; the server continues running.

## Resource and failure behavior

Steady state uses:

- one native process;
- power-adaptive native counter sampling with no periodic Node snapshot stream;
- event-driven Electron power updates plus a 30-second heartbeat;
- no `app.getAppMetrics()` calls while diagnostics is closed;
- no telemetry database;
- no recurring shell probes;
- bounded PubSub queues and native ring history.

The diagnostics page exposes the monitor's own process resource usage and
collection duration so the observer's cost is measurable.

Failures are isolated:

- native failure does not stop the server;
- Electron telemetry loss does not stop native telemetry;
- schema/version errors are visible in health;
- repeated native failures stop automatic restart churn until explicit retry;
- server and desktop shutdown close their respective streams and child process
  scopes.

## Future integration points

High-value follow-up work can use the existing service boundaries:

- opt-in file-path attribution through platform-specific tracing;
- process lifecycle events to reduce the chance of missing very short-lived
  children;
- additional `ResourceAttribution` instrumentation for databases, checkpoints,
  caches, and file synchronization;
- exported diagnostic bundles;
- adaptive sample intervals based on diagnostics visibility and active work.

These additions should preserve the current rules: direct platform APIs,
schema-validated boundaries, explicit metric semantics, bounded retention, and
no mandatory telemetry persistence.
