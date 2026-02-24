# Terminal Runtime And State Plan

## Summary

Terminals appear to "hang" because PTY processes are exiting immediately at startup in the current runtime.

Repro in this branch:

- `node` + `node-pty`: interactive shell stays alive and accepts writes.
- `bun` + `node-pty`: shell exits immediately (`exitCode: 0`, `signal: 1`), so the UI opens a terminal pane but no live process remains.

This means the current breakage is primarily a runtime compatibility issue, plus missing reconciliation between desired terminal state and observed process state.

## Root Cause (Current)

1. Server dev runtime uses Bun (`apps/server/package.json` `dev` script).
2. Terminal PTY implementation depends on `node-pty`.
3. Under Bun, spawned PTY shells exit immediately.
4. Frontend still mounts terminals, so UX looks like startup hang/blank terminal.

## Design Goals

1. Do not store full terminal output in SQLite.
2. Preserve terminal topology and intent across reconnects/restarts:
   - open/split/new/close
   - active terminal/group
   - cwd/env profile
3. Keep runtime truth accurate even when processes change outside the app.
4. Support deterministic recovery and idempotent command handling.

## Proposed Architecture

### 1) Runtime Boundary

- Run terminal PTY host on Node runtime only.
- If main server remains Bun, isolate PTY behind a Node sidecar process (JSON-RPC/IPC).
- Treat PTY host as volatile runtime, not source of durable truth.

### 2) Event-Sourced In SQLite (Control Plane Only)

Persist only control/state events, not output payloads.

Recommended event families:

- `terminal.layout.updated`
  - terminal ids, split groups, active terminal id/group id
- `terminal.open.requested`
  - threadId, terminalId, cwd, envHash/envProfileId, cols, rows
- `terminal.close.requested`
  - terminalId, deleteHistory
- `terminal.resize.requested`
  - cols, rows
- `terminal.clear.requested`
- `terminal.input.sent`
  - input metadata only (`byteLength`, optional hash, optional commandBoundary flag), no raw payload
- `terminal.runtime.started`
  - pid, startedAt, runtime instance id
- `terminal.runtime.exited`
  - pid, exitCode, exitSignal, observedAt, reason (`normal|killed|external|crash|unknown`)
- `terminal.runtime.error`
  - normalized error code/message
- `terminal.output.segment.recorded`
  - segment file id + byte offsets only

Use idempotency keys/command ids for each client command so reconnect retries are safe.

### 3) Output Storage In Log Files (Data Plane)

- Store raw output only in append-only files (per thread+terminal).
- Rotate into segments (size-based and/or time-based).
- Keep lightweight SQLite index rows:
  - `segment_id`, `thread_id`, `terminal_id`, `start_offset`, `end_offset`, `created_at`, checksum.
- Optional retention policy (max bytes / days / segment count per terminal).

This keeps SQLite small while preserving replay capability.

### 4) Reconciliation Loop (Runtime Truth)

Do not treat client dispatch as sole truth.

Maintain dual state:

- Desired state: from event stream/projection.
- Observed runtime state: from PTY host watchers (process exit, health checks, poll).

On mismatch, emit runtime observation events:

- process missing but desired running -> `terminal.runtime.exited` with reason `external|unknown`
- process exists but projection says closed -> terminate process and emit correction event

This makes out-of-band kills/restarts explicit and recoverable.

### 5) Startup/Recovery Flow

1. Rebuild terminal projection from SQLite control events.
2. Load terminal layout/topology immediately for UI.
3. Reconcile each desired running terminal with runtime:
   - if process alive: attach stream + tail recent output from logs
   - if process dead: mark exited; auto-restart only if policy says so
4. Resume incremental output from last persisted offset.

## Data Model Additions

Add dedicated tables (or equivalent repos):

- `terminal_control_events` (or reuse orchestration_events with terminal aggregate kind)
- `terminal_output_segments` (index only, no raw output)
- `terminal_runtime_snapshot` (latest observed runtime state cache)

Avoid embedding output blobs in projection snapshots.

## Implementation Plan

### Phase 0: Stop the bleeding

1. Run PTY on Node runtime in all dev/prod paths (or ship Node sidecar now).
2. Add startup diagnostics: runtime, PTY spawn result, immediate-exit telemetry.
3. Surface clear UI error when PTY host unavailable.

### Phase 1: Durable control events

1. Introduce terminal aggregate + commands/events.
2. Persist layout and terminal lifecycle intent events.
3. Build projection for terminal UI state from events.

### Phase 2: File-backed output + index

1. Implement segmented append-only output logger.
2. Persist only segment metadata/offsets in SQLite.
3. Update terminal history restore to tail from segments (bounded bytes/lines).

### Phase 3: Runtime reconciliation

1. Add process observer + periodic verifier.
2. Emit runtime observation events on drift.
3. Add recovery tests for out-of-band process termination.

### Phase 4: Hardening

1. Backpressure and truncation policies for high-volume output.
2. Crash-safe fsync/flush strategy for segment writes.
3. Retention and compaction jobs.

## Testing Strategy

Backend tests should cover:

1. Rebuild projection from control events (open/split/close/resize/active terminal).
2. Runtime reconciliation when process is killed externally.
3. Recovery after restart with existing segment files.
4. Idempotent command handling on duplicate dispatches.
5. Segment index consistency and retention behavior.

Use real runtime-layer tests for terminal adapter behavior where possible; only mock external process/service boundaries.
