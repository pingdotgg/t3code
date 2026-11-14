# Resource telemetry

Process counters come from a [standalone Rust monitor](../../native/resource-monitor/src/main.rs)
using `sysinfo`. Electron main supplies host power and Electron process metrics.
Keeping native collection outside Node isolates collector crashes and avoids a
Node/Electron addon ABI matrix. Desktop and CLI servers use the same child-process
protocol. A missing or failed collector leaves the server running.

## Collection cost

The native child owns sampling and bounded in-memory history. It samples on a timer
only while diagnostics has live subscribers. With none, the server sends a sample
interval of 0 and the child samples only on request, so an idle server never walks
the process table. The exception is OTLP metrics export: a server exporting metrics
requests one sample a minute and exports process totals by group
([`ProcessGroupMetrics`](../../apps/server/src/resourceTelemetry/ProcessGroupMetrics.ts)),
because the user asked for continuous telemetry. Groups are a fixed set named after
the server's direct children, never process IDs or threads, so the series count
stays bounded as agents come and go. History therefore covers only time with a live
subscriber, plus on-demand and export samples. Consuming host power for background scheduling must not retain
live diagnostics. There is no telemetry database or recurring shell-probe fallback.

History has independent bounds for age, snapshot count, process rows, and retained
bytes. A count limit alone cannot bound memory when command lines vary in size.
Large process trees therefore shorten the available history window. Linux task
enumeration is disabled because walking every `/proc/<pid>/task/<tid>` directory
makes sampling itself expensive.

Electron power updates travel over private inherited pipes, independent of the
renderer connection. Power events and slow heartbeats continue with diagnostics
closed; `app.getAppMetrics()` runs only on live demand. The receiver's stale deadline
must exceed the slowest configured heartbeat plus scheduling grace, or intentional
idle polling makes background policy oscillate between constrained and
unconstrained states. Headless servers leave unavailable power data unknown.

## Whole-machine resources

`server.getHostResources` serves two readers. Load balancing sends `{}` and gets CPU
and memory only ([`HostResources`](../../apps/server/src/resourceTelemetry/HostResources.ts)),
so a slow filesystem can never delay picking a machine. Settings → Diagnostics sends
`detail: "machine"` and polls every 5 seconds while the section is mounted; that adds
volumes and swap from [`HostStorage`](../../apps/server/src/resourceTelemetry/HostStorage.ts).
Servers that predate the field drop the unknown key and answer without `storage`, which
clients show as unsupported, not as an empty machine.

Volumes come from the native monitor's `hostSystem` command (sysinfo `Disks`), read on a
thread of its own so a hung network mount never stalls process sampling. Concurrent
requests share one read. The server keeps a reading for 15 seconds and answers from the
last one if a refresh takes longer than 3 seconds, so an idle server does no disk work
and a busy view costs at most one volume walk per 15 seconds. Without the monitor, it
falls back to `statfs` on the T3 home and worktrees directories, grouped by device id,
and says so in `unavailableReason`. There is no shell probe.

Volume selection drops pseudo filesystems, read-only system snapshots and OS-managed
mounts, and collapses volumes that report the same name, filesystem and size: APFS lists
the sealed system snapshot (`/`) and its Data volume separately with identical capacity.
The volumes holding the T3 home and the worktrees directory are always kept, matched by
real path to the deepest mount. Free space is the space the server's user can write
(macOS "important usage", `f_bavail` elsewhere), and low-disk warnings use absolute free
space rather than percent used: ext4 reserves blocks for root, and 5% of a large disk is
still plenty.

## Measurement traps

- Process identity includes start time because operating systems reuse PIDs.
  Electron and native start times have different precision, so merging allows a
  small tolerance. Process signaling rechecks the native identity with a fresh
  sample.
- Snapshot sequence numbers belong to a monitor generation. Comparing them across
  restarts would discard the new monitor's samples until its sequence caught up.
- Sampling can miss a process that starts and exits between samples. Cumulative
  counters still yield deltas for processes observed across samples.
- Windows process I/O includes more than disk traffic. Unix counters report storage
  I/O, which can differ from logical application reads and writes because of OS
  caching. Keep instrumented logical I/O separate from these counters.
- Group totals accumulate observed deltas since telemetry started. Per-process
  cumulative counters cover the operating system's lifetime for that process.
- Historical replay uses native samples without current Electron CPU or memory
  metrics. Merging the latest Electron values would overwrite the past.

A WSL backend needs a Linux monitor even though Electron runs on Windows. Windows
desktop packages currently supply only the Windows executable, so native process
telemetry for the WSL backend is unavailable. The inherited Electron power feed
still works.
