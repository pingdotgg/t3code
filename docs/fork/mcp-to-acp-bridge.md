# Getting real ACP out of `agy` — two routes

> **Fork-local document.** Specific to the `s243a/t3code` fork, not proposed for
> upstream. See [README](./README.md) for how this relates to the other options.

## Why this exists

Running `agy` in T3 Code's terminal works today and needs no code
([README](./README.md), option 1). But a terminal is a terminal: no approval
cards, no per-turn checkpointing, no thread history. `agy`'s permission prompts
are answered by typing into its TUI.

Everything better requires **ACP**, because that is what T3's provider layer
consumes. T3 already has the machinery — `provider/acp/`, `AcpSessionRuntime`,
proven by the Cursor and Grok drivers — so a driver would mirror `GrokDriver`
(163 lines) plus a `GrokAcpSupport` analogue. `ProviderDriverKind` is an open
slug and Antigravity already exists as an editor target
(`packages/contracts/src/editor.ts:53`), so nothing in contracts or clients
needs to change.

The obstacle is that `agy` does not speak ACP and emits no structured output —
the broker classifies it `format: 'text'` because there is nothing to parse, and
[the upstream feature request][acp-issue] is unshipped.

Two routes get there anyway. Route A is agent-agnostic and is the more
interesting one.

## What ACP actually requires

T3 consumes these, per `apps/server/src/provider/acp/`:

| Method / update | Carries |
| --- | --- |
| `session/prompt` | a user turn going in |
| `session/update` → `agent_message_chunk` | assistant prose |
| `session/update` → `tool_call`, `tool_call_update` | tool activity |
| `session/request_permission` | an approval the client must answer |
| `session/load` | replaying an existing session |

Any bridge is judged on how faithfully it can produce these.

---

## Route A — MCP-gated ACP bridge

**Agent-agnostic. Works with any coding agent that speaks MCP.**

Likely to live in its own repository (working name `MCP-to-ACP`) rather than
inside the broker, since nothing about it is SciREPL-specific.

### The idea

An MCP server sees every tool call an agent makes: name, arguments, and result.
It is not an observer but a **gate** — it can withhold the call. The broker
already demonstrates this shape in `CallToolRequestSchema`, where it validates
each call against the app's advertised tools and rejects anything else.

So invert the usual framing. Rather than parsing what the agent *says*,
intercept what the agent *does*, and expose that as ACP:

```
T3 ──ACP──► bridge ──MCP──► agent (agy, claude, codex, …)
             │
             └─ spawns and supervises the agent process
```

Each `tools/call` becomes a `session/request_permission`, awaited before the
call is relayed. **This is the valuable part**: an approval card on the phone,
answered with a tap, for an agent whose own prompts would otherwise be
auto-denied in headless mode. Tool activity maps to `tool_call` /
`tool_call_update` with no parsing at all.

### What MCP does not carry

MCP is a *tool* channel, not an agent-output channel. Three gaps:

1. **Assistant prose.** Model text goes to stdout or the TUI, never to the MCP
   server. `agent_message_chunk` has no source in MCP. For `agy` specifically,
   headless `-p` stdout *is* the answer as documented plain text — reading that
   is not TUI scraping — but it is per-agent, and it is where the
   agent-agnostic claim thins.
2. **Built-in tools.** An agent's own file read/write and bash calls are
   internal and never reach an MCP server, so they produce no `tool_call`
   event.
3. **Turn boundaries.** MCP has no notion of a turn. The broker's `/agent`
   lifecycle already supplies start and exit.

Gap 2 matters less than it first appears. T3's `CheckpointReactor` captures
**workspace** checkpoints on turn start and completion — it diffs the
filesystem, it does not reconstruct state from the tool-call stream. So file
edits made by built-in tools still show up in T3's diff and checkpoint UI even
with no `tool_call` event behind them. What is lost is live per-action progress
cards during the turn, not the record of what changed.

### Minimum viable bridge

None of the above is a prerequisite. The smallest useful version:

- spawn the agent and expose an MCP server to it;
- emit `tool_call` / `tool_call_update` for MCP calls;
- turn each MCP call into `session/request_permission`;
- emit `agent_message_chunk` from the agent's stdout.

That already yields a real T3 provider — thread history, checkpoints, diffs,
and approval cards for everything routed through MCP — while the agent keeps
using its built-in tools normally under whatever permissions it is configured
with.

### Optional hardening: route built-ins through MCP too

Disabling the agent's built-in tools and having the bridge supply file and shell
equivalents as MCP tools is an **upgrade, not a requirement**. It changes the
security model rather than enabling the feature:

| | Built-ins active | Built-ins disabled |
| --- | --- | --- |
| Privileged actions governed by | the agent's own standing permission config | per-action review at the bridge |
| Bridge sees | MCP calls only | everything |

The second row is why this is worth having eventually: it is the difference
between granting standing permissions once and reviewing each action, which is
the posture [`docs/remote-agent-control.md`][control] argues for. Note that a
headless agent auto-denies permissions it cannot prompt for, so without this the
agent needs standing grants to do privileged work at all.

SciREPL-MCP already has the right pattern for hardening such tools
([`docs/protocol.md`][protocol] §Broker-owned workbook file tools): allowlisted
host roots, reserved `brokerRoot` / `brokerPath` fields that ordinary MCP
callers cannot spoof, and content-free receipts.

Whether a given agent *can* have built-ins disabled decides only whether this
hardening is available for it — not whether the bridge works.

### Known risks

- Permission latency is now in the tool-call path. A slow or absent client
  stalls the agent mid-turn; the bridge needs a timeout policy and a defined
  default (deny, per the review policy in
  [`docs/remote-agent-control.md`][control]).
- Reimplementing file and shell tools means owning their path-hardening. The
  workbook file tools are the precedent to copy, not to loosen.
- An agent that silently falls back to built-ins when an MCP tool fails would
  punch a hole straight through the gate. Verify per agent.

---

## Route B — `agy`'s local Connect API

**agy-specific. Potentially higher fidelity, much narrower.**

Community adapter [`jameslunardi/agy-agent-acp`][connect] drives `agy`'s local
Connect API rather than its CLI, and presents ACP on the other side. Other
adapters ([antigravity-acp][alt1], several `agy-acp` forks) wrap the CLI
instead.

Attraction: a real API is a sound foundation where scraped terminal output is
not, and it may carry assistant prose and tool activity together — closing
Route A's gap 1 and gap 2 at once.

Cost: it is one agent only. Nothing learned transfers to claude, codex, or
gemini, where Route A would work unchanged.

**Unverified.** Nobody here has confirmed what the Connect API exposes, whether
it is stable, or whether it is intended for external use. Treat the adapters as
evidence it is *possible*, not that it is *supportable*. Investigate only if
Route A hits the built-in-tools wall.

---

## Recommendation

Build Route A's minimum viable bridge. It does not depend on any unresolved
question: permission gating over MCP calls works with the agent's built-in tools
left alone, and T3's workspace checkpoints already cover what the built-ins
change.

Treat routing built-ins through MCP as later hardening, driven by wanting
per-action review instead of standing grants — not as a gate on shipping.

Route B is a fallback for `agy` alone, worth investigating only if Route A's
fidelity proves insufficient in practice.

Either route, once it emits ACP, needs the same small piece on this side: a T3
driver modelled on `GrokDriver` + `GrokAcpSupport`, spawning the bridge instead
of `grok agent stdio`.

[acp-issue]: https://github.com/google-antigravity/antigravity-cli/issues/31
[protocol]: https://github.com/s243a/SciREPL-MCP/blob/main/docs/protocol.md
[control]: https://github.com/s243a/SciREPL-MCP/blob/main/docs/remote-agent-control.md
[connect]: https://github.com/jameslunardi/agy-agent-acp
[alt1]: https://github.com/shubzkothekar/antigravity-acp
