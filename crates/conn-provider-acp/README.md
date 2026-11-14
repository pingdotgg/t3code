# conn-provider-acp

The ACP provider for Conn Server: agents that speak the Agent Client Protocol (JSON-RPC on
stdio). One shared runtime, one small flavor per agent. Reference behaviour: T3's
`packages/provider-acp` (`makeAcpAdapterV2`, `AcpSessionRuntime`) and the flavor packages
(`packages/provider-grok`, …) in the Conn monorepo.

**State (2026-11-14): Grok, offered by the server.** The server lists T3's default `grok`
instance, off until `providerInstances.grok` enables it, and probes the CLI as T3 does (see
"Server entry"). `/compact` is served as T3 serves it (see "Compaction"). Kiro, fx,
Antigravity and the ACP registry are not built. Grok's background work and subagents are not
built: see "Not built" and "Map: Grok background work".

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
| `grok_status`, `probe` | Grok's `ServerProvider` entry: the CLI probes and the entry T3 builds from them |

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

## Server entry (proven equal to T3's for Grok, see "Proofs")

`AcpProvider::refresh_status` runs T3's `checkGrokProviderStatus` with the instance's settings
entry; `server_provider_entry` returns the last result. The server calls it once it listens,
when `providerInstances.grok` changes, every `providerHealthRefreshInterval` (5 minutes), and on
`server.refreshProviders`, and sends `providerStatuses` on config streams.

- **Enabled:** `resolveProviderInstanceEnabled`: an explicit `false` on the envelope or in the
  config wins, then the envelope, then the config, then Grok's default: off. Off: no probe,
  `status: "disabled"`, "Grok is disabled in T3 Code settings."; a session on it is refused.
- **Probes**, in order, each in its own process group with the server's environment, the
  instance's entries, `MISE_OFFLINE=1` and `GROK_DISABLE_AUTOUPDATER=1`, stdin an open pipe:
  `grok --version` (10 s), `grok models` (10 s; once more after "not authenticated" when no
  `XAI_API_KEY` is set), `grok inspect --json` in the server's workspace (4 s, skills), and
  `grok agent stdio` with one `initialize` as client `t3-code-provider-probe` without the
  elicitation capability (20 s, models and slash commands), ended with SIGKILL to its group.
  A timeout sends SIGTERM to the group and SIGKILL after 1 s. `T3CODE_GROK_PROBE_TIMEOUT_MS`
  only lengthens a timeout.
- **Results:** a missing executable: installed `false`, "Grok CLI (`grok`) is not installed or
  not on PATH."; any other spawn failure: "Failed to execute Grok CLI health check."; a hang:
  "… timed out while running `grok --version`."; a non-zero exit: "… failed to run."; logged
  out: `error`, "Run `grok login`."; a failed ACP probe or no models: `warning`, "Model
  options may be incomplete." T3 has no minimum Grok version: an old CLI is reported with its
  version and whatever its probes give.
- **A disabled instance** is refused at dispatch by the engine, as T3 does (see
  `docs/status.md`, "ACP provider, part 3"); the provider's own refusal of the session stays as
  a second guard.
- **Not ported, on purpose:** `readGrokAccount` (it reads Grok's credentials file and calls
  xAI's billing API; this server never reads credentials), the version advisory (it asks a
  package registry for the latest version), the background-work demand gate on the periodic
  probe and the 30 s recheck after a failed check, the debounce on `providerStatuses`.
  `XAI_API_KEY` is checked for presence only; its value is never stored or sent anywhere.

## Supported (Grok)

Streamed text and reasoning (named and unnamed segments, the 50 ms flush), session titles and
context usage, `/compact` (see "Compaction"), tool calls (merge, Grok normalization, the persist rule, read / execute / edit
/ generic projections, file diffs), todo plans and proposed-plan updates, permission requests
with T3's disposition rules and Grok's choices, Grok's `ask_user_question`, prompt failures
(RPC errors and xAI `error` / `rate_limit` completions), model switch, Stop, close, agent
exit. Unknown methods and updates are skipped and logged once per kind; agent requests we do
not serve get a -32601 reply.

## Compaction (Grok: `supportsCompaction`)

As T3's adapter does for a flavor with `supportsCompaction`:

- `/compact` goes to Grok as a plain prompt, without T3's instruction wrapper and runtime notes
  (a native slash command). A message `/compact` in any case and with no attachments is sent
  as exactly `/compact`, as T3's orchestrator does through `compactThread`.
- A `/compact` turn that completes (also `/compact <instructions>`) marks the session
  compacted; so does a `compaction_update` with status `completed` (each compaction id once;
  the last 128 ids are kept, T3 keeps all) and a completed "Compact context" tool. The next
  prompt then sends T3's instructions and runtime notes again. A prompt that carried them
  clears the mark only when it succeeds and no newer compaction came while it ran.
- Prompt delivery is recorded only when the prompt succeeds (not `cancelled`, `refusal`,
  `error`, or a failed request), as T3 records `promptInstructionStates` in the reply callback.
- `compaction_update` and `compaction_summary_chunk` become one "Compact context" tool per
  compaction id; its turn item has the type `compaction`, the summary, and the token count
  before. A completed one clears the session's context usage.
- A `/compact` turn that completes without such a tool gets T3's "Context compacted" item
  (`<turn>:compaction`) and clears the context usage.

Proof: two scenarios made by `tools/make-scenarios.mjs` from the recorded `multi_turn`
transcript (`testdata/grok-scenarios/`: `grok_compact` without and `grok_compact_update` with
the agent's own compaction updates). They are not live recordings. `capture-ts-events.mjs`
runs them through T3's fixture runner and Grok adapter, so T3 decides the golden events and
prompts; our replay and the stub conformance check compare against those.

## Not built

- **Grok background work:** background shell tasks, monitors, deferred finalize (3 s
  debounce), post-settle continuation prompts, subagents and their child threads, the x.ai
  extension notifications behind them. The five transcripts that need them are on
  `testdata/grok/expected-failures.txt`. See "Map: Grok background work" for the plan.
- **Grok extras:** `x.ai/exit_plan_mode`, skill mentions (`rewriteUserText`), the reasoning effort in `session/set_model` meta, model slug
  aliases, `promptInactivityTimeout`, image attachments as blocks (text paths only), MCP tool
  presentation (`extractMcpToolCallIdentity`), web search and fetch projections, structured
  file changes, notices, retries.
- **Shared runtime:** ACP protocol 2 responses (Kiro answers with v2), `session/load` and
  resume at open, fork, `session/set_config_option`, steering, elicitation, MCP over ACP,
  client file and terminal callbacks (`ProviderHost`; only Antigravity's files and the
  registry's terminals use them in T3, Grok never does), authentication on `auth_required`.
- **Linux launch:** T3 puts Grok's process tree in a cgroup wrapper on Linux
  (`ownDescendantProcessGroups`); we spawn it directly. macOS matches.
- **Flavors:** Kiro, fx, Antigravity (its own adapter and stdout filter), the ACP registry
  and its 11 `server.*` methods.

## Map: the ACP registry's download and install (T3, read in part 3; not built)

Read from `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts` (ARS) at the pin.
This server must not download or install; the choice is Nick's.

- **Index:** `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (HTTPS
  only, 30 s, at most 1 MiB and 512 agents), cached at `<T3 home>/caches/acp-registry/
  registry.json`; search reuses it for 5 minutes, prepare always fetches, a failed fetch falls
  back to the cache.
- **Install** under `<T3 home>/tools/<agentId>/<version>/`, by `distribution` (`auto` tries
  binary, then npx, then uvx):
  - binary: the archive for `{darwin,linux,windows}-{aarch64,x86_64}` (20 min, at most 1 GiB),
    SHA-256 checked only when the index gives one, no signature; paths checked, `tar` or
    `unzip` into a temp folder, `chmod 755` on `cmd`, renamed into place; run as
    `<root>/<cmd>` with the index's `args` and `env`.
  - npx: `npm install --global <pkg@exact>` with `npm_config_prefix=<root>/npm`, lifecycle
    scripts run (no `--ignore-scripts`), from the user's npm registry; npx itself never runs.
  - uvx: `uv tool install --force <pkg==exact>` with `UV_TOOL_DIR`/`UV_TOOL_BIN_DIR` under
    `<root>/python`.
- **Who installs:** `server.prepareAcpRegistryAgent`, and any agent start (`resolve`), which
  the session, provider and logout methods do.
- **Uninstall** deletes only the binary platform folders; npm and uv installs, receipts and
  the cache stay. No update step: a new index version installs beside the old one.
- **Methods:** of the 11, only `uninstallAcpRegistryManagedBinary` and
  `acceptAcpRegistryUrlAuth` need no network and no install; the other nine fetch the index,
  install, or start the agent.

## Map: Grok background work

What T3 does (`packages/provider-acp/src/server/adapter.ts` at the pin, with Grok's hooks in
`packages/provider-grok/src/server/adapter.ts` and `xaiAcpExtension.ts`), read for the
`grok_background_bash` transcript. Our replay of it differs first at event 26: we complete
the tool and the turn when the prompt settles; T3 keeps both open.

1. **Hooks** (`makeGrokAcpAdapterFlavor`): `extractBackgroundTaskId` =
   `extractXAiMonitorTaskId`; `isBackgroundCommandTool` = a `BackgroundTaskStarted`
   `rawOutput`; `extractBackgroundTaskCompletion` = `extractXAiBackgroundTaskCompletion` +
   `extractXAiKilledBackgroundTasks`; `extractBackgroundToolMutation` (monitor events in agent
   text); `isPersistentBackgroundTool` = `isXAiPersistentMonitor`;
   `isProviderWakeNotification` = a `task-completed-*` `_meta.promptId`;
   `deferFinalizeForBackgroundWork` and `enablePostSettleContinuation`. Our
   `normalizeXAiAcpToolCallState` port lacks the "BackgroundTaskStarted → inProgress" and
   monitor reopen rules.
2. **Per turn** (`ActiveAcpTurn`): `backgroundCommands` (task id → completion or null),
   `toolCallIdsByBackgroundTaskId`, `persistentBackgroundTaskIds`,
   `awaitingBackgroundHydration` (60 s), `pendingInjectedReport` (25 s), `promptSettled` and
   its status, `backgroundFinalizeGeneration`. **Per session:** `runningBackgroundTaskIds`,
   `endedBackgroundTaskIds` (128 tombstones), `handledBackgroundTaskIdsInActiveTurn`,
   `midTurnUnreportedCompletedTaskIds`, `wakeBuffer`, `wakeReports`,
   `continuationRequested` and its generation, `lastTurnRoute`.
3. **Tools** (`emitTool`): a background command keeps its tool `inProgress`; tool updates that
   arrive after the prompt settled still update the open turn's tool (the `tock` output).
4. **Lifecycle notifications** (`registerXAiBackgroundTaskTracking`):
   `x.ai/task_backgrounded` and `x.ai/task_completed` (and the `_x.ai/` forms) become
   `applyBackgroundTaskMutation`: completion recorded, wake report, `finishRegisteredBackgroundTool`.
5. **Prompt settles** with background work: `promptSettled = true`, text streams close, no
   finalize. Each change re-arms `scheduleDeferredFinalize`: after 3 s with no deferred work
   the turn finalizes with the settled status.
6. **Wakes:** after the settle, Grok starts its own `task-completed-*` turn. Its frames go to
   `wakeBuffer` (`bufferPostSettleWake`, with `acpPostSettleWakeEvidence`,
   `acpPostSettleContinuationOfferEvidence`, `acpPostSettleWakeShouldBuffer`), and once no
   background task runs, `offerContinuationRun` asks the engine for a continuation
   (`ProviderEvent::ContinuationRequested` exists in `conn-provider` and the engine runs it).
7. **Continuation turn:** `startTurn` with a provider continuation message (`createdBy:
   agent`, `creationSource: provider`) sends **no** prompt: it drains `wakeBuffer` through the
   normal update handler, marks the prompt settled, and finalizes (or defers) as in 5.
   Today we send the message text ("Background task completed.") as a prompt: the frame
   check fails there.
8. **Subagents and monitors** add `extractXAiAcpSubagentUpdate`, child app threads
   (`app_thread.created`, `subagent.updated`), `registerXAiSubagentFinished`, carryover
   subagents across turns, and monitor-event hydration. They come after 1 to 7.

The work is in `mapper.rs` (turn state, tools) and `session.rs` (prompt settle, wake routing,
continuation turn); the clock seam for the 3 s debounce is the session's `flush_interval`
style option, so the replay can run without real waits.

Size, read in part 3: in T3's `adapter.ts` the parts this needs are `handleSessionUpdate`
(614 lines), `emitTool` (496), `startTurnUnlocked` (507), `finalizeTurn` (194),
`bufferPostSettleWake` (121), `offerContinuationRun` (75), `applyLateBackgroundMutation` and
`finishRegisteredBackgroundTool`, the wake helpers (`acpPostSettleWakeEvidence`,
`acpPostSettleWakeShouldBuffer`, `acpPostSettleContinuationOfferEvidence`), the subagent and
carryover functions (`emitSubagent` 288, `syncNativeChildren` 124, `projectCarryoverSubagentStatus`
96, and more), and `xaiAcpExtension.ts` (`registerXAiBackgroundTaskTracking`,
`xAiBackgroundTaskLifecycleMutation`, `extractXAiBackgroundTaskCompletion`,
`extractXAiKilledBackgroundTasks`, `extractXAiAcpBackgroundToolMutation`,
`extractXAiAcpSubagentUpdate`). The continuation request of step 6 maps to
`ProviderEvent::ContinuationRequested`, as the Claude provider uses it. The fixture replay
also needs a replay gate in `acp-stub.mjs` (`finish_held_run`).

## Proofs

```sh
cargo test -p conn-provider-acp                                                 # offline
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/conformance.mjs   # the wire check
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/probe-conformance.mjs   # the status probe
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/gen-instructions.mjs --check
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/make-scenarios.mjs   # the hand-made scenarios
CONN_MONOREPO=/path/to/conn node crates/conn-provider-acp/tools/capture-ts-events.mjs grok   # regenerate testdata
```

- **Replay (`src/replay_tests.rs`, in `cargo test`):** every Grok transcript of the T3 test
  kit (15) runs through our whole session against an in-memory agent with the rules of T3's
  `acp-replay-agent.ts` (`matchesExpected` ported rule for rule); every `expect_outbound` frame
  must match, and every event must equal what T3's adapter emitted for the same transcript
  (captured by `tools/capture-ts-events.mjs` through T3's own fixture runner; timestamps and
  random uuids normalized). **12 of 17 pass**: 10 of T3's 15 recorded transcripts and both
  hand-made compaction scenarios. The other 5 are listed with their reason, and the test
  fails when a listed one passes or an unlisted one fails.
- **Probe conformance (`tools/probe-conformance.mjs`, in `tools/check.sh`):** T3's own
  `checkGrokProviderStatus` and ours, each against a stub CLI (`tools/grok-cli-stub.mjs`) per
  scenario: disabled, missing, not executable, `--version` hangs and ignores SIGTERM,
  `--version` fails, an old CLI without `models`, `inspect` or ACP, ready, logged out, a
  refreshed token, an API key in the instance environment, ACP hangs, ACP error, `models`
  hangs with bad skills output, custom models with a display name. Compared: the entry
  (`checkedAt` aside) and, per CLI run, argv, environment, folder, stdin lines and signals.
  **14 of 14 the same.** One normalisation: T3 ends the ACP probe's stdin just before its
  SIGKILL and the stub logs that only sometimes, so a last "stdin-closed" is not compared.
  The real client decodes a probed, ready Grok entry: `effect-client.mjs` enables Grok with
  the stub CLI through `server.updateSettings` and reads `server.refreshProviders`.
- **Stub conformance (`tools/conformance.mjs`, in `tools/check.sh`):** the same stub agent
  under T3's real Grok adapter and spawn path and under `AcpProvider`; argv, environment,
  every stdin line byte for byte (workspace path and trace ids normalized) and the shutdown
  order compared. **12 of 12 scenarios the same** (the passing fixtures and the compaction
  scenarios; the 5 others are skipped and listed). It found three differences, fixed: ids from 2^30, the trace context
  after the id, and kill-on-close.
- **Bounded state:** `state_stays_bounded_over_many_turns` runs 200 turns with text, a tool
  call and an approval each; no turn, request or reply is left behind.
- **Fixture replay (`crates/conn-engine/tools/t3-fixture-replay`, in `tools/check.sh`):** the
  engine runs T3's Grok fixtures with this provider on a stub `grok` that runs T3's own ACP
  replay agent, and T3's assertions judge the result. Grok 1 of 15 (`turn_interrupt`): frames
  are equal for the 10 non-background variants; the assertions fail on an engine difference
  (buffered delivery, 9 variants) and on the background work this crate lacks. Each variant is
  listed with its cause. The driver sets `text_flush_interval: None`, as T3's test clock holds
  the 50 ms flush.
- Unit tests: frame parsing and key order, the matcher, the prompt texts against T3's own
  functions (`testdata/instructions.json`), the policy rules, the diff format, the compaction
  marks.

## Memory

One agent process per session, as T3. The status probe holds one entry per instance and
starts at most one CLI at a time; each probe stream keeps at most 4 MiB of output (T3 keeps
all of it). Our side per session: one mapper (per-turn maps dropped
at the turn's end), one connection (a pending map with one entry per request in flight), two
bounded channels (256) and four small tasks (stdin writer, stdout reader, stderr tail,
supervisor) plus the reader that routes frames. Agent lines are capped at 64 MiB; longer ones
are dropped and logged. The compaction ids a session remembers are capped at 128 (T3 keeps
all).

Measured (macOS arm64, `examples/idle_memory.rs`, against the stub agent of the conformance
check): one idle session holds about 310 KiB of live heap on our side after one turn
(`simple` +318,078 B, `multi_turn` +318,236 B); 11 KiB stays after close. Not broken down. A
`ProviderEvent` is 1,560 bytes, and tokio's bounded channel allocates 32 slots (about 49 KiB)
per block, so the event channel is a likely part. The agent process is not counted. **Not
measured** on a live Grok: no agent may start in this step.

## Live proofs for a later step (Grok, cheapest model, behind a flag)

A turn with streamed text; an approval in supervised mode; Stop during a tool call and the
next turn after it (process restart and `session/load`); a model switch; a prompt that fails
(an unknown model); close leaving no process; the Linux cgroup launch.
