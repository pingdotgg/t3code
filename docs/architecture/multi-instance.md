# Multi-Instance Architecture

T3 Code supports running multiple isolated instances on a single machine. This document describes
the isolation model, the instance registry, the `--instance` convenience flag, the `t3 instances`
command, and the desktop multi-window behavior.

---

## What Is an Instance

Every T3 server instance owns an independent **base directory** (`baseDir`). The base directory is
the root for all state that belongs to that instance:

- SQLite database (threads, projects, orchestration history)
- Server settings
- Secrets store
- Log files
- Git worktrees

Two instances with different base directories cannot interfere with each other's data. This is
the isolation guarantee.

The base directory is resolved in priority order:

1. `--base-dir <path>` flag on the CLI
2. `T3CODE_HOME` environment variable
3. `--instance <name>` convenience (see below)
4. Platform default (`resolveBaseDir(undefined)`)

### Dynamic Port Assignment

In web mode (headless server), when no `--port` flag is specified, the server calls
`findAvailablePort(DEFAULT_PORT)` starting from port `3773`. Each new instance therefore binds
the first available port above `3773`. Port `3773` is claimed by the first instance that starts;
subsequent instances bind `3774`, `3775`, and so on.

In desktop mode the default behavior pins port `3773`. The multi-window extension described at
the end of this document changes that behavior.

---

## The `--instance` Convenience Flag

Running two default-`baseDir` instances on the same machine would cause them to share the same
SQLite database and settings — they would collide.

The `--instance <name>` flag assigns a friendly name that maps to a deterministic, isolated
base directory automatically:

```text
<defaultBaseRoot>/instances-data/<name>
```

Examples:

```bash
t3 start --instance work
t3 start --instance personal
t3 start --instance experiment
```

Each name produces a completely separate data directory. The name can be any identifier that is
safe for a directory component. No two instances share data as long as their names differ.

The `--instance` flag is a shorthand. Passing `--base-dir` with an explicit path is equivalent
and has identical isolation properties.

---

## The Instance Registry

### Purpose

The registry answers the question: *which instances are currently running on this machine?*

Without a registry, there is no way to discover a running instance's port or PID — you would
have to scan ports or parse process lists. The registry solves discovery in a structured, low-
overhead way.

### Mechanism: JSON Lock Files

A running instance announces itself by writing a JSON lock file to a shared directory:

```text
<defaultBaseRoot>/instances/<instanceId>.json
```

`instanceId` is a stable identifier for the instance (derived from its `baseDir`).

The lock file is written on server start and deleted on clean shutdown. On unclean shutdown the
file is left behind and treated as stale (see Stale Entry Pruning below).

### Lock File Shape

```jsonc
{
  "instanceId": "string",   // stable identifier derived from baseDir
  "name": "string | null",  // value of --instance flag, or null
  "pid": 1234,              // OS process ID of the server
  "port": 51234,            // bound TCP port
  "host": "127.0.0.1",      // bind host
  "baseDir": "/abs/path",   // absolute path to this instance's base directory
  "cwd": "/abs/path",       // working directory the server was started from
  "startedAt": "ISO",       // ISO 8601 timestamp
  "schemaVersion": 1        // integer version for forward compatibility
}
```

This is the canonical shape defined in Contract C1.

### Stale Entry Pruning

When `t3 instances` or any registry reader enumerates the lock files, it checks whether the
recorded `pid` is still alive. If the process is dead the entry is treated as stale, removed from
the result set, and optionally deleted from disk. Callers must never assume that a lock file
corresponds to a live process without checking `pid`.

---

## The `t3 instances` Command

`t3 instances` lists all live instances discovered in the registry.

Example output:

```text
NAME          INSTANCE ID         PORT    PID     BASE DIR
work          work-a3f2           3773    84123   ~/.t3/instances-data/work
personal      personal-b1c9       3774    84456   ~/.t3/instances-data/personal
(default)     default-cc1a        3775    85001   ~/.t3
```

Each row corresponds to one live lock file entry. Stale entries are pruned before the table is
printed. If no live instances are found the command prints a message indicating the registry is
empty.

The command does not require a running server — it reads the shared lock file directory directly.

---

## Connecting to a Named Instance

Once instances are running, `t3 start --instance <name>` in a second terminal reuses the same
base directory and port as the named instance. This is useful for scripted reconnects or for
opening a second client window against an existing instance.

```bash
# Start the instance
t3 start --instance work

# Later, connect a second client to the same instance
t3 start --instance work
```

The second invocation finds port `3773` (or whichever port `work` bound) already occupied, so
`findAvailablePort` skips it and the new server lands on the next free port — but both instances
share the same `baseDir` (`~/.t3/instances-data/work`), so they share state. For the common
use case of a single client per instance this is transparent.

---

## Desktop Multi-Window

The desktop app currently uses `requestSingleInstanceLock` to enforce a single process and pins
port `3773`. True multi-window support requires lifting those constraints.

**Current state:** Single-instance lock is in `apps/desktop/src/electron/ElectronApp.ts`.
Removing it and adding per-window port assignment are the two changes needed.

**Target behavior:**

- Each new desktop window calls `findAvailablePort` (same as web mode today).
- Each window writes its own registry entry so `t3 instances` lists all open windows.
- The `--instance <name>` flag is available from the desktop app's "New window" flow to pre-select
  an isolated base directory.

**Sprint 1 status:** Multi-window desktop is specified here. Implementation is deferred to a
follow-up pass. The single-instance enforcement lives in
`apps/desktop/src/app/DesktopCloudAuth.ts` and is entangled with OAuth deep-link handling;
removing it safely requires a typecheck pass. See `SPRINT_1_DELIVERABLE.md` for the open
question.

---

## Summary

| Concern | Mechanism |
| --- | --- |
| Data isolation | Per-instance `baseDir` (different SQLite, settings, secrets) |
| Port assignment | `findAvailablePort(DEFAULT_PORT)` in web mode |
| Friendly name | `--instance <name>` → `<defaultBaseRoot>/instances-data/<name>` |
| Discovery | JSON lock file per instance in `<defaultBaseRoot>/instances/` |
| Stale cleanup | PID liveness check on every registry read |
| List command | `t3 instances` |
| Desktop | Deferred; see sprint deliverable |

See also:

- [Runtime modes](./runtime-modes.md)
- [Remote Architecture](./remote.md)
- [Remote Control user guide](../user/remote-control.md)
