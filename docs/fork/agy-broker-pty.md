# Stage 2 — running `agy` over a SciREPL broker PTY

> **Fork-local document.** This describes work specific to the `s243a/t3code`
> fork and is not proposed for upstream. It lives under `docs/fork/` so it stays
> out of `docs/internals/`, which upstream owns.

## Status

Design only. Nothing here is implemented. Stage 1 (run `agy` in T3 Code's
existing thread terminal, same machine as the server) needs no code and is the
current recommended path.

## Sources

Every protocol claim below is sourced to a public document, so this design can
be published alongside the fork:

- T3 Code's PTY contract — `apps/server/src/terminal/PtyAdapter.ts` (this repo)
- The broker wire protocol — [`docs/protocol.md`][protocol] §Terminal (`/term`)
  in the public [SciREPL-MCP][mcp] repository, vendored at
  `.repos/scirepl-mcp` on the `claude/scirepl-mcp-submodule-gs2ifz` branch

No part of this design derives from SciREPL Pro. The adapter implements T3
Code's own interface against the published broker protocol; it does not port
the Pro client.

## Problem

Stage 1 covers the common case: `agy` on the same machine as the T3 server,
typed into a thread terminal. It works today, survives disconnects, and replays
scrollback from disk.

It does not cover `agy` running on a **different machine** from the T3 server.
T3 Code has no cross-host terminal or provider transport at all. The SciREPL
broker already solves exactly that shape — it spawns a PTY on its own host and
relays it over a WebSocket — so the gap is a transport adapter, not a feature.

Target topology:

```
phone ──► T3 server (machine A) ──► broker (machine B) ──► PTY: agy, on B
          [T3 WS/RPC]              [broker /term WS]
```

Reverse-worker mode (`/worker`) is explicitly **out of scope**. It exists to
relay to a third host beyond the broker, and this design does not need that
indirection: the broker's ordinary `/term` already spawns the PTY on the broker
host, which is where `agy` runs.

## The seam

`PtyAdapter` is a `Context.Service` with a single method, and T3 already ships
two implementations (`NodePtyAdapter`, `BunPtyAdapter`) precisely so it can be
swapped:

```ts
spawn(input: PtySpawnInput): Effect<PtyProcess, PtySpawnError>

interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): () => void
  onExit(cb: (e: PtyExitEvent) => void): () => void
}
```

Everything above it — `TerminalManager`, the wire contract, web/desktop/mobile
UI, disk-persisted scrollback — is transport-agnostic and is reused unchanged.
A third implementation is the entire feature.

### Call mapping

| `PtyProcess` | Broker `/term` message |
| --- | --- |
| construction | `{type:"start", cmd, cols, rows}` → `started` |
| `write(data)` | `{type:"input", data}` |
| `resize(c,r)` | `{type:"resize", cols, rows}` |
| `kill()` | `{type:"stop"}` |
| `onData(cb)` | `{type:"term", kind:"data"}` |
| `onExit(cb)` | `{type:"term", kind:"exit"}` |

Message shapes are quoted from [`docs/protocol.md`][protocol] §Terminal.

`NodePtyAdapter` (172 lines) is the structural template: a small class wrapping
a handle, plus an `Effect.fn` factory returning `PtyAdapter.PtyAdapter.of({ spawn })`.

## Constraints that shape the design

These are the parts that are *not* a mechanical translation. Each one is a real
mismatch between the two models.

### 1. The adapter is resolved once, not per spawn

`TerminalManager` takes `ptyAdapter` as a constructor option
(`Manager.ts:1113`) and resolves it once (`Manager.ts:1134`). There is no
per-session adapter selection.

**Therefore:** do not register `BrokerPtyAdapter` as the service. Register a
single **delegating** adapter that inspects `PtySpawnInput` — which carries
`shell`, `args`, `cwd`, `cols`, `rows`, `env` — and routes each spawn to either
the local node-pty path or the broker path. `Manager.ts` needs no changes.

The routing key should be explicit rather than inferred. An `env` marker set
when the terminal is opened is the least surprising option, since `env` already
flows end-to-end through `TerminalOpenInput`.

### 2. The broker hosts exactly one PTY, globally

`termBridge` is a module-level singleton holding one `pty`. A `start` while a
PTY exists **reattaches to it** rather than spawning a second one, replying
`started` with `reattached: true`.

T3 supports many terminals across many threads. These models do not agree.

**Therefore:** treat one broker as capacity for exactly one T3 terminal. A
second broker-routed terminal must fail cleanly at open time with an
explanatory error — never silently adopt another terminal's session, which
would cross-wire two threads' output. This is the single most important
correctness constraint in this design.

### 3. `started` carries no pid

The broker replies `{kind:"started", cmd}`; the pid is logged on the broker host
but never sent. T3's `PtyProcess.pid` is a required `number`.

**Therefore:** synthesize a stable negative pid per broker session so it cannot
collide with a real local pid. Consequence to accept: `registerTerminalProcesses`
feeds `PortScanner`, so **port discovery and preview detection do not work for
broker terminals**. That is a real feature loss, not a rough edge — it should be
stated in the UI rather than silently degraded.

### 4. `cwd` is the broker's, not T3's

The broker spawns with `cwd: AGENT_CWD`, its own configured workspace. T3's
per-terminal `cwd` has no effect.

**Therefore:** the working directory is broker configuration, not T3 state. The
UI must not imply otherwise — showing a local path for a remote terminal would
be a lie. Surface the broker's advertised workspace instead, or no path at all.

### 5. `shell` is a path; `cmd` is an allowlist label

T3 passes a resolved shell path (`env.SHELL ?? "bash"`). The broker takes a
label, validates it against `BROKER_TERM_CMDS`, and rejects anything else with
`command not allowed: … (allowed: …)`. The `welcome` event advertises the
permitted set as `cmds`.

**Therefore:** the adapter maps to a label, never a path. Read `cmds` from
`welcome` and fail the spawn with a clear `PtySpawnError` when the wanted label
is absent — the allowlist is the broker owner's security boundary and the
adapter must respect it rather than route around it.

For this fork's purpose the label is `agy`. Keeping `shell` **out** of
`BROKER_TERM_CMDS` is the deployment's decision and is what makes the remote
surface meaningfully narrower than an ssh session.

### 6. Grace window versus T3's retention

The two layers disagree about how long a detached session lives:

| | Detached session lifetime |
| --- | --- |
| T3 | 128 retained sessions; scrollback persisted to disk; survives server restart |
| Broker | `BROKER_TERM_GRACE_MS`, default 600000 (10 min), then the PTY is reaped |

T3 is the more durable of the two. After the grace window the broker's PTY is
gone while T3 still believes the session exists.

**Therefore:** a `start` that returns `started` *without* `reattached: true`
when T3 expected a live session means the process was reaped. Surface that as an
exit, so the UI shows a dead terminal instead of a live one that silently lost
its history. Raising `BROKER_TERM_GRACE_MS` narrows the window but cannot close
it, and must not be treated as a fix.

### 7. Spawn is a round trip

Local spawn is effectively synchronous. The broker path requires connect →
`hello` → `start` → `started` before a `PtyProcess` can be returned.

**Therefore:** `spawn` awaits `started` and maps `{kind:"error"}` and connect
failure onto `PtySpawnError` (which already carries `adapter`, `shell`, `cause`).
It needs a timeout; an unreachable broker must fail the open rather than hang
it. `exit` carries `code` only, so `PtyExitEvent.signal` is always `null`.

## What this does not buy

A terminal is a terminal. There are no approval cards, no per-turn
checkpointing, and no thread history — `agy`'s permission prompts are answered
by typing into the TUI, including the ctrl+g expansion needed to read truncated
commands before approving them.

Those require structured output from `agy`, which it does not emit: the broker
classifies it `format: 'text'` because there is nothing to parse. The blocker is
[agy's own ACP/JSON-RPC feature request][acp], not the broker and not T3. If
`agy` ever gains a structured mode, the better integration is a native T3
provider driver modelled on `GrokDriver` + `GrokAcpSupport`, and this adapter
becomes redundant rather than a foundation.

## Open questions

1. How does a user mark a terminal as broker-routed? Project setting, per-open
   choice, or a dedicated environment concept.
2. Where do the broker URL and token live? They are per-environment secrets and
   must not land in thread state.
3. Should the single-PTY limit be enforced at open time in the UI, or surfaced
   as a spawn error? Failing early is friendlier but needs the capacity check
   somewhere the client can reach.

## Implementation sketch

One new file, `apps/server/src/terminal/BrokerPtyAdapter.ts`, plus a delegating
adapter and its wiring. Estimated size comparable to `NodePtyAdapter` (172
lines). No changes to `Manager.ts`, the terminal contract, or any client.

Tests should follow `NodePtyAdapter.test.ts` and drive a fake broker socket:
allowlist rejection, reattach detection, grace-window expiry surfaced as exit,
and the second-terminal refusal from constraint 2.

[protocol]: https://github.com/s243a/SciREPL-MCP/blob/main/docs/protocol.md
[mcp]: https://github.com/s243a/SciREPL-MCP
[acp]: https://github.com/google-antigravity/antigravity-cli/issues/31
