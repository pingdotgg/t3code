# Stage 2 — running `agy` over a SciREPL broker PTY

> **Fork-local document.** This describes work specific to the `s243a/t3code`
> fork and is not proposed for upstream. It lives under `docs/fork/` so it stays
> out of `docs/internals/`, which upstream owns.

## Status: not recommended

**An earlier revision of this document claimed T3 Code has no cross-host
terminal transport. That was wrong.** T3 already solves the cross-host case,
and this adapter is not needed to run `agy` on another machine.

The design below is retained because the constraint analysis is accurate and
would matter if the narrow remaining case (see [Does anything survive?](#does-anything-survive))
is ever worth building. Nothing here is implemented.

## What T3 already does

T3's remote model puts remoteness at the **connection layer**, never by
splitting the runtime ([`docs/internals/remote.md`](../internals/remote.md)):

```
one T3 server per machine = one ExecutionEnvironment
client keeps a list of known environments and connects to whichever it wants
```

A client — including the phone — holds many saved environments and talks
directly to each server. Access methods already shipped: direct LAN, bearer
pairing, Tailscale serve, T3 Connect relay tunnels, and desktop-managed SSH.

So for `agy` on machine B, controlled from a phone:

1. Run a T3 server on B. The desktop app will even do this for you over SSH —
   it "probes the host, starts or reuses a remote T3 server, opens a local port
   forward, and saves the environment"
   ([remote access](../user/remote-access.md), Option 3).
2. Pair the phone to that environment. Tailscale pairing goes through the
   ordinary bearer path.
3. Open a terminal in a thread on B and type `agy`.

Zero code, on the same machine or a different one. Terminal scrollback is
persisted to disk and replayed on reattach, so this survives disconnects.

### Why "spawn the broker from a T3 terminal" doesn't rescue the design

It is circular. T3's terminal spawns on **the machine its own server runs on**.
Using it to start a broker starts that broker on machine A — which does nothing
to reach machine B. To start the broker on B you need execution on B, and the
only ways to get it are a T3 server on B (which makes the broker redundant) or
an out-of-band shell (which is the thing the broker was meant to replace).

## Does anything survive?

Transport was the argument for this adapter, and T3 wins it. Two narrower
arguments remain, and neither is about reach:

**Privilege surface.** A T3 server on B grants a full login shell, filesystem,
git, and provider access. The broker with `BROKER_TERM=1` and
`BROKER_TERM_CMDS=agy` grants exactly one PTY running one named binary, with no
shell. If B is a machine where you want `agy` reachable but do *not* want a
general-purpose remote development server, that difference is real — and it is
a security argument, not a capability one.

**The supervision workflow.** Per-prompt permission review with an audit trail
has no T3 equivalent. That is a distinct product idea and does not need this
adapter to exist.

Neither justifies the work today. Revisit only if the privilege-surface
argument becomes concrete.

## Sources

Every protocol claim below is sourced to a public document, so this design can
be published alongside the fork:

- T3 Code's PTY contract — `apps/server/src/terminal/PtyAdapter.ts` (this repo)
- The broker wire protocol — [`docs/protocol.md`][protocol] §Terminal (`/term`)
  in the public [SciREPL-MCP][mcp] repository

No part of this design derives from SciREPL Pro. The adapter would implement T3
Code's own interface against the published broker protocol; it does not port
the Pro client.

---

# Design, if it were built

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
UI, disk-persisted scrollback — is transport-agnostic and reused unchanged.

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
`NodePtyAdapter` (172 lines) is the structural template.

Reverse-worker mode (`/worker`) is out of scope: it relays to a third host
beyond the broker, and the broker's ordinary `/term` already spawns the PTY on
the broker host, which is where `agy` runs.

## Constraints

These are the parts that are not a mechanical translation. Each is a real
mismatch between the two models, and they are the reason this adapter is more
than an afternoon.

### 1. The adapter is resolved once, not per spawn

`TerminalManager` takes `ptyAdapter` as a constructor option
(`Manager.ts:1113`) and resolves it once (`Manager.ts:1134`). There is no
per-session adapter selection.

**Therefore:** register a single **delegating** adapter that inspects
`PtySpawnInput` — which carries `shell`, `args`, `cwd`, `cols`, `rows`, `env` —
and routes each spawn to either the local node-pty path or the broker path. An
`env` marker is the least surprising routing key, since `env` already flows
end-to-end through `TerminalOpenInput`. `Manager.ts` needs no changes.

### 2. The broker hosts exactly one PTY, globally

`termBridge` is a module-level singleton holding one `pty`. A `start` while a
PTY exists **reattaches to it** rather than spawning a second one, replying
`started` with `reattached: true`.

T3 supports many terminals across many threads. These models do not agree.

**Therefore:** treat one broker as capacity for exactly one T3 terminal. A
second broker-routed terminal must fail cleanly at open time — never silently
adopt another terminal's session, which would cross-wire two threads' output.
This is the most important correctness constraint here.

### 3. `started` carries no pid

The broker replies `{kind:"started", cmd}`; the pid is logged on the broker host
but never sent. T3's `PtyProcess.pid` is a required `number`.

**Therefore:** synthesize a stable negative pid so it cannot collide with a real
local pid. Consequence to accept: `registerTerminalProcesses` feeds
`PortScanner`, so **port discovery and preview detection do not work for broker
terminals**. A real feature loss, and it should be stated in the UI rather than
silently degraded.

### 4. `cwd` is the broker's, not T3's

The broker spawns with `cwd: AGENT_CWD`, its own configured workspace. T3's
per-terminal `cwd` has no effect. The UI must not show a local path for a remote
terminal.

### 5. `shell` is a path; `cmd` is an allowlist label

T3 passes a resolved shell path (`env.SHELL ?? "bash"`). The broker takes a
label, validates it against `BROKER_TERM_CMDS`, and rejects anything else. The
`welcome` event advertises the permitted set as `cmds`.

**Therefore:** map to a label, never a path. Read `cmds` from `welcome` and fail
with a clear `PtySpawnError` when the wanted label is absent. The allowlist is
the broker owner's security boundary; the adapter respects it rather than
routing around it. This constraint is also the privilege-surface argument above.

### 6. Grace window versus T3's retention

| | Detached session lifetime |
| --- | --- |
| T3 | 128 retained sessions; scrollback persisted to disk; survives server restart |
| Broker | `BROKER_TERM_GRACE_MS`, default 600000 (10 min), then the PTY is reaped |

T3 is the more durable of the two. After the grace window the broker's PTY is
gone while T3 still believes the session exists.

**Therefore:** a `start` returning `started` *without* `reattached: true` when
T3 expected a live session means the process was reaped. Surface that as an exit
so the UI shows a dead terminal rather than a live one that lost its history.
Raising `BROKER_TERM_GRACE_MS` narrows the window but cannot close it.

### 7. Spawn is a round trip

Local spawn is effectively synchronous; the broker path needs connect → `hello`
→ `start` → `started` before returning a `PtyProcess`.

**Therefore:** `spawn` awaits `started` and maps `{kind:"error"}` and connect
failure onto `PtySpawnError`. It needs a timeout — an unreachable broker must
fail the open rather than hang it. `exit` carries `code` only, so
`PtyExitEvent.signal` is always `null`.

## What this would not buy

A terminal is a terminal: no approval cards, no per-turn checkpointing, no
thread history. `agy`'s permission prompts are answered by typing into the TUI,
including the ctrl+g expansion needed to read truncated commands before
approving them.

Those need structured output from `agy`, which it does not emit — the broker
classifies it `format: 'text'` because there is nothing to parse. The blocker is
[agy's own ACP/JSON-RPC feature request][acp], not the broker and not T3. If
`agy` gains a structured mode, the right integration is a native T3 provider
driver modelled on `GrokDriver` + `GrokAcpSupport`, and this adapter becomes
redundant rather than a foundation.

[protocol]: https://github.com/s243a/SciREPL-MCP/blob/main/docs/protocol.md
[mcp]: https://github.com/s243a/SciREPL-MCP
[acp]: https://github.com/google-antigravity/antigravity-cli/issues/31
