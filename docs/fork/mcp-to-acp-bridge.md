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
   internal and never reach an MCP server. For a coding agent editing a repo
   that is most of the interesting activity, and it would be invisible.
3. **Turn boundaries.** MCP has no notion of a turn. The broker's `/agent`
   lifecycle already supplies start and exit.

Gap 2 is load-bearing. In the SciREPL case the agent drives the notebook
*exclusively* through broker tools, so the broker sees everything. A coding
agent editing files does not work that way.

### Making it complete

Disable the agent's built-in tools and have the bridge supply file and shell
equivalents as MCP tools. The bridge then sees and gates **100%** of what the
agent does, and emits complete, faithful `tool_call` and permission events with
no per-agent parsing.

SciREPL-MCP already has the right pattern for hardening such tools
([`docs/protocol.md`][protocol] §Broker-owned workbook file tools): allowlisted
host roots, reserved `brokerRoot` / `brokerPath` fields that ordinary MCP
callers cannot spoof, and content-free receipts.

### The question that decides this route

**Can each target agent be run with built-in tools disabled, or restricted to
MCP-provided ones?**

- Yes → complete visibility, genuinely agent-agnostic, full permission control.
- No → partial visibility (MCP tools only) plus per-agent stdout parsing for
  prose.

Establish this for `agy` before building. It is cheap to check and it changes
what the thing is.

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

Investigate the built-in-tools question for `agy` first — one fact, cheaply
obtained, that decides whether Route A is complete or partial.

Route A is worth more even in its partial form, because permission gating works
regardless of the gaps and applies to every MCP-speaking agent. Route B is a
fallback for `agy` alone.

Either route, once it emits ACP, needs the same small piece on this side: a T3
driver modelled on `GrokDriver` + `GrokAcpSupport`, spawning the bridge instead
of `grok agent stdio`.

[acp-issue]: https://github.com/google-antigravity/antigravity-cli/issues/31
[protocol]: https://github.com/s243a/SciREPL-MCP/blob/main/docs/protocol.md
[control]: https://github.com/s243a/SciREPL-MCP/blob/main/docs/remote-agent-control.md
[connect]: https://github.com/jameslunardi/agy-agent-acp
[alt1]: https://github.com/shubzkothekar/antigravity-acp
