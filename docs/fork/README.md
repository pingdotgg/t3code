# Fork-local design docs

Documents specific to the `s243a/t3code` fork. They live here rather than in
`docs/internals/` — which upstream owns — so provenance stays obvious and
rebases against upstream stay clean. Nothing here is proposed upstream.

## Goal

Run the Antigravity CLI (`agy`) from a phone, through T3 Code.

## Options, in the order they should be considered

### 1. T3's existing terminal — shipped, zero code

Open a thread terminal on the machine where `agy` lives and type `agy`.

Works on the same machine as the T3 server or a different one, because T3
expresses remoteness at the connection layer: one server per machine, and a
client holds many saved environments and connects to each directly. Desktop can
even start a remote server over SSH and pair it
([remote access](../user/remote-access.md), Option 3).

Terminal scrollback is persisted to disk and replayed on reattach, so this
survives disconnects. **Start here.** It costs nothing to find out whether it is
already enough.

Limits: a terminal is a terminal — no approval cards, no per-turn checkpointing,
no thread history. `agy`'s permission prompts are answered by typing into its
TUI, including the ctrl+g expansion needed to read truncated commands before
approving them.

### 2. ACP bridge — the way to get a real T3 provider

[mcp-to-acp-bridge.md](./mcp-to-acp-bridge.md)

Two routes to making `agy` speak ACP, which is what T3's provider layer
consumes:

- **Route A, MCP-gated bridge.** Intercept the agent's MCP tool calls and expose
  them as ACP, turning each call into a permission request. Agent-agnostic;
  likely its own repository (working name `MCP-to-ACP`).
- **Route B, `agy`'s local Connect API.** Higher potential fidelity, one agent
  only, unverified.

Route A has a minimum viable form with no open prerequisites: gate the agent's
MCP calls as ACP permission requests and take assistant prose from stdout, while
the agent keeps its built-in tools. Routing built-ins through MCP as well is
later hardening — it buys per-action review instead of standing grants, and is
not needed to ship.

### 3. Broker PTY adapter — documented, not recommended

[agy-broker-pty.md](./agy-broker-pty.md)

Relay T3's `PtyAdapter` to the SciREPL broker's `/term` endpoint. Written when
option 1 was believed not to cover cross-host; **it does**, so the transport
argument for this is gone.

Retained because the constraint analysis is accurate and the narrow remaining
argument — privilege surface, a machine where you want `agy` reachable but not a
general-purpose remote dev server — may become concrete later.

## Status

Nothing in options 2 or 3 is implemented. Option 1 needs no implementation.
