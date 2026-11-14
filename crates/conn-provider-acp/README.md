# conn-provider-acp

The ACP provider for Conn Server: agents that speak the Agent Client Protocol (JSON-RPC on
stdio). One shared runtime, one small flavor per agent. Reference behaviour: T3's
`packages/provider-acp` (`makeAcpAdapterV2`, `AcpSessionRuntime`) and the flavor packages
(`packages/provider-grok`, …) in the Conn monorepo.

**State (2026-11-14): Grok only, and not registered in the server.** Kiro, fx, Antigravity
and the ACP registry are not built. See "Not built" for what Grok still lacks and why the
server does not offer it yet.

## Trial: the official crates or our own JSON-RPC?

Asked before the crate took shape: can the official schema crate send what the T3 server
sends, and what does it cost? Rule 4 of `AGENTS.md` decides.

| | Result |
| --- | --- |
| `agent-client-protocol-schema` 1.17.0 (crates.io, updated 2026-11-10, 6.9 M downloads), `unstable_protocol_v2`, no default features | Cannot express T3's `initialize`. effect-acp sends one negotiating request with both the v2 fields (`info`, `capabilities`) and the v1 fields (`clientCapabilities`, `clientInfo`). Round-tripped through the v1 type it loses `info` and `capabilities`, gains `clientCapabilities.auth`, and reorders keys; through the v2 type it loses `clientCapabilities` and `clientInfo`. T3's replay matcher compares key sets, so the frame fails. `session/new` and `session/prompt` round-trip unchanged. |
| Its cost, measured on the release build of `conn-server` (decode of 7 types, encode of 1) | 12,855,648 → 13,433,904 bytes: **+578,256 bytes (565 KiB)**; 148 → 171 packages in the normal dependency tree (+23, most of them proc macros) |
| `agent-client-protocol` 5.2.0 (the full crate) | Not used: it numbers requests with UUID strings and defaults to version 1. T3 numbers them from 2^30 (see "Wire"). |
| **Choice** | **Our own JSON-RPC and `serde_json::Value` reads**, as in the Codex provider: no new dependency, and frames that match T3's byte for byte. |

The workspace's `serde_json` sorts object keys (no `preserve_order`), so every frame we
write is built from `ordered::J`, which keeps T3's key order.

## Layout

| Module | Holds |
| --- | --- |
| `protocol`, `ordered` | JSON-RPC frames, written with T3's key order |
| `connection` | request ids, replies, and the agent's other frames on one bounded channel |
| `mapper` | the turn state machine: frames → `ProviderEvent`s and replies (pure, replay-tested) |
| `tools`, `diff` | tool call state and projection (`runtimeModel.ts`, `toolActivity.ts`), jsdiff-style unified diffs |
| `policy` | `acpPermissionDisposition` (allow, ask, deny under the runtime policy) |
| `prompt`, `instructions` | T3's prompt wrapper and runtime notes (`instructions.rs` is generated) |
| `session` | `Session`: process, handshake, model switch, prompts, Stop, close |
| `flavor`, `grok` | what differs per agent; Grok's tool normalizer, questions and model switch |

## Wire (proven equal to T3's for Grok, see "Proofs")

- **Launch:** `grok` (or the configured binary), argv from `grokAcpSpawnArgs` of
  `grokLaunchRuntimeMode` (`agent --always-approve stdio` in full access;
  `--permission-mode default agent stdio` when the policy has its own approval or sandbox
  setting), environment inherited plus the instance's entries plus
  `GROK_OAUTH2_REFERRER=t3code`, in a new process group, working folder = the thread's cwd.
- **Requests:** `{"jsonrpc","method","params","id","traceId","spanId","sampled":true}`, ids
  from 2^30 counting up, as T3's Effect RPC client writes them; the trace ids are random per
  request on both sides. Replies to agent requests: `{"jsonrpc","id","result"}`.
- **Handshake:** `initialize` (protocol 2, the negotiating v2+v1 shape, `clientInfo`
  `t3-code` `0.0.0`, Grok's `_meta.clientType: extension`), then `session/new` with `cwd` and
  `mcpServers` (HTTP servers when the agent offers HTTP), then `session/set_model` when the
  selection names another model than the session's.
- **Prompt:** T3's instruction wrapper on the first prompt and when the mode or tools change,
  the runtime notes until a prompt carrying them succeeds; Grok's `_meta.promptId` and
  `requestId` `t3-xai-prompt-N`. A prompt settles on its reply or Grok's `prompt_complete` /
  `turn_completed`, whichever comes first, in order with the updates before it.
- **Stop (Grok):** the turn ends as interrupted, then SIGTERM to the process group, SIGKILL
  after 1 s; the next turn starts a new agent and loads the session (`session/load`).
- **Close:** `session/close` when the agent offers it, then SIGKILL to the process group at
  once (T3's scope finalizer for an owned detached group). No end of input first.

## Supported (Grok)

Streamed text and reasoning (named and unnamed segments, the 50 ms flush), session titles and
context usage, tool calls (merge, Grok normalization, the persist rule, read / execute / edit
/ generic projections, file diffs), todo plans and proposed-plan updates, permission requests
with T3's disposition rules and Grok's choices, Grok's `ask_user_question`, prompt failures
(RPC errors and xAI `error` / `rate_limit` completions), model switch, Stop, close, agent
exit. Unknown methods and updates are skipped and logged once per kind; agent requests we do
not serve get a -32601 reply.

## Not built

- **Grok background work:** background shell tasks, monitors, deferred finalize (3 s
  debounce), post-settle continuation prompts, subagents and their child threads, the x.ai
  extension notifications behind them. The five transcripts that need them are on
  `testdata/grok/expected-failures.txt`.
- **Grok extras:** `x.ai/exit_plan_mode`, skill mentions (`rewriteUserText`), compaction via
  `/compact`, the reasoning effort in `session/set_model` meta, model slug aliases,
  `promptInactivityTimeout`, image attachments as blocks (text paths only), MCP tool
  presentation (`extractMcpToolCallIdentity`), web search and fetch projections, structured
  file changes, notices, retries.
- **Shared runtime:** ACP protocol 2 responses (Kiro answers with v2), `session/load` and
  resume at open, fork, `session/set_config_option`, steering, elicitation, MCP over ACP,
  client file and terminal callbacks (`ProviderHost`), authentication on `auth_required`.
- **Linux launch:** T3 puts Grok's process tree in a cgroup wrapper on Linux
  (`ownDescendantProcessGroups`); we spawn it directly. macOS matches.
- **Server:** the `ServerConfig` provider entry. T3 builds Grok's from probes that run the
  CLI (`grok --version`, a model probe, an ACP `initialize` probe) and reports auth from them;
  none is built, so the server does not offer Grok yet.
- **Flavors:** Kiro, fx, Antigravity (its own adapter and stdout filter), the ACP registry
  and its 11 `server.*` methods.

## Proofs

```sh
cargo test -p conn-provider-acp                                                 # offline
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/conformance.mjs   # the wire check
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/gen-instructions.mjs --check
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/capture-ts-events.mjs grok   # regenerate testdata
```

- **Replay (`src/replay_tests.rs`, in `cargo test`):** every Grok transcript of the T3 test
  kit (15) runs through our whole session against an in-memory agent with the rules of T3's
  `acp-replay-agent.ts` (`matchesExpected` ported rule for rule); every `expect_outbound` frame
  must match, and every event must equal what T3's adapter emitted for the same transcript
  (captured by `tools/capture-ts-events.mjs` through T3's own fixture runner; timestamps and
  random uuids normalized). **10 of 15 pass**; the other 5 are listed with their reason, and
  the test fails when a listed one passes or an unlisted one fails.
- **Stub conformance (`tools/conformance.mjs`, in `tools/check.sh`):** the same stub agent
  under T3's real Grok adapter and spawn path and under `AcpProvider`; argv, environment,
  every stdin line byte for byte (workspace path and trace ids normalized) and the shutdown
  order compared. **10 of 10 scenarios the same** (the passing fixtures; the 5 others are
  skipped and listed). It found three differences, fixed: ids from 2^30, the trace context
  after the id, and kill-on-close.
- **Bounded state:** `state_stays_bounded_over_many_turns` runs 200 turns with text, a tool
  call and an approval each; no turn, request or reply is left behind.
- Unit tests: frame parsing and key order, the matcher, the prompt texts against T3's own
  functions (`testdata/instructions.json`), the policy rules, the diff format.

## Memory

One agent process per session, as T3. Our side per session: one mapper (per-turn maps dropped
at the turn's end), one connection (a pending map with one entry per request in flight), two
bounded channels (256) and four small tasks (stdin writer, stdout reader, stderr tail,
supervisor) plus the reader that routes frames. Agent lines are capped at 64 MiB; longer ones
are dropped and logged. **Not measured** on a live agent: no agent may start in this step.

## Live proofs for a later step (Grok, cheapest model, behind a flag)

A turn with streamed text; an approval in supervised mode; Stop during a tool call and the
next turn after it (process restart and `session/load`); a model switch; a prompt that fails
(an unknown model); close leaving no process; the Linux cgroup launch.
