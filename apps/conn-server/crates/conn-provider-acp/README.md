# conn-provider-acp

The ACP provider for Conn Server: agents that speak the Agent Client Protocol (JSON-RPC on
stdio). One shared runtime, one small flavor per agent. Reference behaviour: T3's
`packages/provider-acp` (`makeAcpAdapterV2`, `AcpSessionRuntime`) and the flavor packages
(`packages/provider-grok`, …) in the Conn monorepo.

**State (2026-11-14): Grok, offered by the server.** The server lists T3's default `grok`
instance, off until `providerInstances.grok` enables it, and probes the CLI as T3 does (see
"Server entry"). `/compact` is served as T3 serves it (see "Compaction"), and so are Grok's
background work and subagents (see "Background work and subagents").

**State (2026-11-20): Antigravity, offered by the server** (see "Antigravity"). Kiro, fx and
the ACP registry are not built (see "Not built").

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
| `grok_background` | Grok's background signals (`xaiAcpExtension.ts`): task ids, get-output and kill results, monitor text, lifecycle notifications, subagent updates |
| `mapper_background`, `mapper_subagents` | the background part of the turn machine (deferred finalize, wake buffer, continuation) and native subagents (child threads, messages, tools) |
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
  `mcpServers`, then `session/set_model` when the selection names another model than the
  session's, or (protocol 1) a reasoning effort the model offers, as `_meta.reasoningEffort`;
  a rejected effort is dropped and the switch sent again without it.
- **`/mcp` (`acpMcpContext`, `sessionMcpServers`):** the `conn` server goes as the stdio
  bridge `{name, command, args: ["acp-mcp-bridge"], env: [ELECTRON_RUN_AS_NODE=1,
  T3_ACP_MCP_ENDPOINT, T3_ACP_MCP_AUTHORIZATION]}`; as `{type: http, …}` only when the
  agent offers HTTP and the flavor sets `mcpOverHttp` (T3: Grok, Kiro and fx no;
  Antigravity yes; the registry only for Copilot). `conn-server acp-mcp-bridge` relays the
  agent's stdio MCP to `/mcp` as T3's `AcpMcpStdioBridge` does (`crates/conn-server/src/
  acp_mcp_bridge.rs`). **One accepted difference:** `command` is this server's executable,
  not T3's Node binary and script (`selfInvocationArgs`); the stub conformance normalizes
  it. `ELECTRON_RUN_AS_NODE=1` is kept: T3 sets it so an Electron executable runs as Node,
  our binary ignores it, and the agent sees T3's list. T3's `acp` entry (MCP over ACP) is not
  built; no built flavor's agent offers `acp`. The bridge is one more process per agent
  session: 3.9 MiB resident, 2.0 MiB physical footprint while idle (release, macOS arm64).
- **Attachments:** each saved path in the prompt text (`providerMessageTextWithAttachmentPaths`,
  from `AcpConfig::attachments_dir`), and native images as `{type: image, data, mimeType}`
  blocks after the text (`supportsImagePrompts`: Grok sends them even without
  `promptCapabilities.image`).
- **Instance environment:** `~` is expanded only in `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and
  `GROK_HOME` (`HOME_PATH_VARIABLES`; `probe-conformance.mjs` checks the list).
- **Prompt:** T3's instruction wrapper on the first prompt and when the mode or tools change,
  the runtime notes until a prompt carrying them succeeds; Grok's `_meta.promptId` and
  `requestId` `t3-xai-prompt-N`. A prompt settles on its reply or Grok's `prompt_complete` /
  `turn_completed`, whichever comes first, in order with the updates before it.
- **Stop (Grok):** the turn ends as interrupted, then SIGTERM to the process group, SIGKILL
  after 1 s; the next turn starts a new agent and loads the session (`session/load`).
- **Close:** `session/close` when the agent offers it, then SIGKILL to the process group at
  once (T3's scope finalizer for an owned detached group), after the end of input: T3's ACP
  writer stream completes and ends stdin just before the kill, so ours ends input first
  (waiting at most 200 ms for the pipe to close).

## Server entry (proven equal to T3's for Grok, see "Proofs")

`AcpProvider::refresh_status` runs T3's `checkGrokProviderStatus` with the instance's settings
entry; `server_provider_entry` returns the last result. The server calls it once it listens,
when `providerInstances.grok` changes, every `providerHealthRefreshInterval` (5 minutes), and on
`server.refreshProviders`, and sends `providerStatuses` on config streams (de-duped, then
debounced 200 ms, as T3's `ws.ts`). The periodic probe follows T3's managed provider loop
(`refresh_status_on_interval`): a disabled instance is not probed, and a failed check
(`error`, not signed out) over a ready entry keeps that entry and is checked again after 30 s
(`FAILED_CHECK_RECHECK_DELAY`); the recheck publishes what it finds.

- **Enabled:** `resolveProviderInstanceEnabled`: an explicit `false` on the envelope or in the
  config wins, then the envelope, then the config, then Grok's default: off. Off: no probe,
  `status: "disabled"`, "Grok is disabled in Conn settings."; a session on it is refused.
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
  xAI's billing API; this server never reads credentials) and the version advisory (it asks a
  package registry for the latest version). The demand gate on the periodic probe (T3 probes
  on the interval only while a client's activity lease asks for provider status) is served
  by the server for every provider (`crates/conn-server/src/methods/provider.rs`).
  `XAI_API_KEY` is checked for presence only; its value is never stored or sent anywhere.

## Supported (Grok)

Streamed text and reasoning (named and unnamed segments, the 50 ms flush), session titles and
context usage, `/compact` (see "Compaction"), background shell tasks, monitors and subagents
(see "Background work and subagents"), tool calls (merge, Grok normalization, the persist rule, read / execute / edit
/ generic projections, file diffs), todo plans and proposed-plan updates, permission requests
with T3's disposition rules and Grok's choices, Grok's `ask_user_question`, prompt failures
(RPC errors and xAI `error` / `rate_limit` completions), model switch, Stop, close, agent
exit. Unknown methods and updates are skipped and logged once per kind; agent requests we do
not serve get a -32601 reply.

## Background work and subagents (Grok: `deferFinalizeForBackgroundWork`, `enablePostSettleContinuation`)

As T3's adapter does for Grok (`makeAcpAdapterV2` with Grok's hooks):

- **Background tools.** A tool whose output is `BackgroundTaskStarted`, or a monitor, keeps its
  row running after the prompt settles; Grok's normalizer reopens the start ACK. A completed
  turn does not terminalize background or subagent tools.
- **Deferred finalize.** When the prompt settles with background work open, the turn stays
  open. `x.ai/task_completed`, a get-output result or a kill ends a task; the tool gets its
  output and status, and the turn finalizes 3 s after the last change
  (`ACP_DEFERRED_FINALIZE_DEBOUNCE`; `AcpConfig::finalize_debounce`), with the settled status.
  Monitor events in the agent's text hydrate the tool (60 s wait, 25 s for an injected report).
- **Wake and continuation.** Grok's own `task-completed-*` turn after the settle finalizes the
  waiting turn; its frames go to a wake buffer, and the first real wake evidence asks the
  engine for one continuation (`ProviderEvent::ContinuationRequested`). The continuation turn
  (`createdBy: agent`, `creationSource: provider`) sends **no** prompt: it replays the buffer
  through the update handler and finalizes after the debounce. Frames a turn already handled
  are dropped, as T3 drops them. Stop quarantines the run: its later frames wake nothing.
- **Subagents.** A spawn tool becomes a subagent row in the parent thread (node, turn item,
  `subagent.updated`) and a child app thread (`app_thread.created`) with the prompt. Once the
  child's ACP session id is known (`Agent ID:` / `subagent_id:` in the output), the child's
  provider thread appears and its assistant text and tools show in the child thread; earlier
  child frames are held until then. Hydration (get-output) and Grok's `subagent_finished` or
  an end notice finish the subagent; a running subagent holds the turn's finalize.
- **Bounds.** Per turn: one entry per background tool or subagent, dropped with the turn.
  Per session: at most 256 running, handled and unreported task ids each (T3: no bound), 128
  ended-task tombstones (as T3), 4,096 wake frames (T3: no bound; more are dropped and
  logged), 1,024 held frames per child session (T3: no bound).

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

- **Grok background work, the rest:** subagents carried over to a later turn (T3's
  `carryoverSubagents`: a subagent still running when its turn finalized as interrupted or
  failed, finished later; its end is dropped here), the wake reports T3 attaches to the
  continuation request as a notification (`ContinuationRequest` has no field for it), the
  `subagentsIdleOnTurnCompletion` and agent-work-state rules (not Grok's), MCP tool
  presentation in subagent tool rows.
- **Grok extras:** `x.ai/exit_plan_mode`, skill mentions (`rewriteUserText`), model slug
  aliases, `promptInactivityTimeout`, the reasoning effort on ACP protocol 2 (Grok answers
  protocol 1), MCP tool
  presentation (`extractMcpToolCallIdentity`), web search and fetch projections, structured
  file changes, notices, retries.
- **Shared runtime:** ACP protocol 2 responses (Kiro answers with v2; only `auth/login`
  follows the reply's shape), `session/load` and resume at open, fork, config options other
  than Antigravity's model, steering, elicitation, MCP over ACP, client terminal callbacks
  (the registry's), file writes, authentication on `auth_required`.
- **Linux launch:** T3 puts Grok's process tree in a cgroup wrapper on Linux
  (`ownDescendantProcessGroups`); we spawn it directly. macOS matches.
- **Flavors:** Kiro, fx, the ACP registry. Antigravity's gaps are listed under "Antigravity".
- **The ACP registry's download and install: not to be built (Nick, 2026-11-14).** This
  server installs nothing: no index download, no binary, npm or uv install. Of the registry's
  11 `server.*` methods only `uninstallAcpRegistryManagedBinary` and `acceptAcpRegistryUrlAuth`
  need neither network nor install; they and the user's own `local` agents are the only
  registry parts that may come here. The other nine stay unregistered and the capability stays
  unadvertised, as a lasting, deliberate gap (see the map below). None of the registry is
  built yet.

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

## Antigravity (`antigravity.rs`, `antigravity_provider.rs`)

T3's Antigravity driver for the `agy` CLI found on `PATH` or set as `binaryPath`
(`AntigravityDriver.ts`, `antigravityAuthSupport.ts`, `AntigravityAcpSupport.ts`,
`AntigravityAdapterV2.ts`). The server lists the default `antigravity` instance (off) and one
more per `providerInstances` entry with that driver (`supportsMultipleInstances`).

- **Credential:** the instance's `apiKey` setting, a settings secret as in T3 (moved out of
  `settings.json` into `<state>/secrets`), passed to the agent as `GEMINI_API_KEY`
  (`gemini-api-key`) or `GOOGLE_API_KEY` (`agent-platform`). Never logged. Other variables of
  the server's environment reach the agent, so a model endpoint the host sets (Orbit:
  `GOOGLE_GEMINI_BASE_URL`) applies.
- **Launch:** `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp`, profile
  `<state>/providers/antigravity/<sha256 of the instance id>` (0700) with
  `antigravity-acp/settings.json` naming the sign-in method; the driver's own keys removed
  from the inherited environment, then `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE`,
  `BROWSER`, `PYTHONUNBUFFERED`, `ELECTRON_RUN_AS_NODE`, and `TMPDIR` = a fresh
  `run-<random>` folder per process, removed after it ends.
- **Wire:** `initialize` as client `zed` 0.0.0 (the CLI's version is unknown before it
  answers; T3 the same) with `fs.readTextFile`; `authenticate` with the configured method
  before `session/new`; `session/new` with `additionalDirectories: [attachments]` and the pull
  request linking text as `_meta.antigravity.systemPrompt.append` when the agent offers it
  (then the runtime notes leave it out); the model through `session/set_config_option` on the
  `model` option (unknown models refused with T3's text, 1.3 ids of a listed family passed
  through); Stop as `session/cancel`, waiting for the prompt's reply; a restarted agent gets
  `session/resume`. `fs/read_text_file` is served inside the turn's workspace and the
  attachments folder (`conn-provider-support` `RootedFiles`).
- **Status:** the executable resolves and the sign-in is configured. While the account is
  unknown, the check opens a throwaway session in a scratch folder (as T3's `loadModels`);
  that session, like every session, sets `ready` and the models (T3's `onSessionStarted`).
  Once the account is known, the check starts no agent. The version is read fresh in every check with
  `<agy> --version` (5 s), so it follows the binary Orbit puts on `PATH`; T3 runs no
  `--version` and keeps the last version it saw. `setup.canInstall` is `false`: Orbit
  installs and updates the CLI (Nick, 2026-11-20); T3 says `true` for its managed runtime.
- **One accepted difference:** `BROWSER` runs this server (`<self> antigravity-browser -- %s`,
  which reports the URL on stderr with T3's marker) where T3 runs its Node with an inline
  script.
- **Not built:** browser sign-in (`provider.auth.*` answer "no sign-in" for every provider);
  T3's managed runtime (`localharness_external`) and its install; links to `~/.gemini`
  skills; `AntigravityProtocol` (tool call normalization, read repair, `interaction_*`
  questions, the `allow_always` security warning); audio, text, PDF and video attachments as
  ACP resources (images go as image blocks, every path in the text); background commands,
  child work and subagents (`deferFinalizeForBackgroundWork`, `toolOutlivesPrompt`,
  `watchPromptOutcome`); the stderr harness-failure and stdout sign-in URL filters; the
  prompt inactivity timeout; per-turn usage; thinking levels per model; text generation;
  usage limits; slash commands in the entry.

## Proofs

```sh
cargo test -p conn-provider-acp                                                 # offline
node crates/conn-provider-acp/tools/conformance.mjs   # the wire check
node crates/conn-provider-acp/tools/antigravity-conformance.mjs   # Antigravity's launch and wire
node crates/conn-provider-acp/tools/probe-conformance.mjs   # the status probe
node crates/conn-provider-acp/tools/gen-instructions.mjs --check
node crates/conn-provider-acp/tools/make-scenarios.mjs   # the hand-made scenarios
node crates/conn-provider-acp/tools/capture-ts-events.mjs grok   # regenerate testdata
```

- **Replay (`src/replay_tests.rs`, in `cargo test`):** every Grok transcript of the T3 test
  kit (15) runs through our whole session against an in-memory agent with the rules of T3's
  `acp-replay-agent.ts` (`matchesExpected` ported rule for rule); every `expect_outbound` frame
  must match, and every event must equal what T3's adapter emitted for the same transcript
  (captured by `tools/capture-ts-events.mjs` through T3's own fixture runner; timestamps and
  random uuids normalized). **17 of 17 pass**: all 15 of T3's recorded transcripts and both
  hand-made compaction scenarios. The test fails when a listed one passes or an unlisted one
  fails (none is listed). The replay follows T3's fixture steps: a fixture's replay gate
  (`release_replay_gate`, recorded as `gates` in the golden file by `capture-ts-events.mjs`)
  holds its agent frame until the run before it ended; a provider continuation request
  (T3 offers it outside the event stream) is checked to come before each continuation turn
  and is left out of the event comparison; the deferred finalize debounce is 5 ms, and the
  text flush fires before it, as T3's test clock fires both on one advance.
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
  order compared. **17 of 17 scenarios the same**, `simple` with a T3 MCP session (the `/mcp`
  scenario: the bridge entry and the prompt's T3 tool notes) (every fixture and both compaction
  scenarios). The stub holds a gated frame across processes (`gates` in its config): T3's
  side bridges its fixture gate and finish hook to it, ours releases it once the run ended.
  It found four differences, fixed: ids from 2^30, the trace context after the id,
  kill-on-close, and the end of input before the kill at close. The stub records from a
  worker in its own process group, which the client's signals do not reach, so every end of
  input is recorded however soon the kill follows; the check waits for each worker's exit
  record before it compares (green in 14 of 14 runs beside release builds on a loaded
  machine, 2026-11-14). The probe check's stub still records inside the killed group and
  keeps its normalisation of a last "stdin-closed".
- **Bounded state:** `state_stays_bounded_over_many_turns` runs 200 turns with text, a tool
  call and an approval each; no turn, request or reply is left behind.
- **Fixture replay (`crates/conn-engine/tools/t3-fixture-replay`, in `tools/check.sh`):** the
  engine runs T3's Grok fixtures with this provider on a stub `grok` that runs T3's own ACP
  replay agent, and T3's assertions judge the result. Grok 10 of 15: frames are equal for the
  10 non-background variants, and since the engine delivers streamed text as T3 does and
  lists messages in T3's order, all 10 pass. The 5 others replay equal in this crate's own test,
  but fail there: 4 because the driver's replay gate is not wired to the ACP stub, 1 on a
  missing subagent provider thread in the engine's projection. Each is listed with its cause. The driver sets
  `text_flush_interval: None`, as T3's test clock holds the 50 ms flush.
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
check, 2026-11-14 after the background work): one idle session holds about 314 KiB of live
heap on our side after one turn (`simple` +320,981 B, `multi_turn` +321,155 B; +318 KB before
the background work); 11 KiB stays after close. Where it goes: two 64 KiB line readers
(stdout, and the stderr tail; `conn-provider-support` reads lines through a 64 KiB
`BufReader`), the event channel's first block (measured: 50,656 B, 32 slots of a 1,560-byte
`ProviderEvent`), the agent's `initialize` and `session/new` replies kept as
`serde_json::Value` (about 10 KB of JSON for Grok's model list, several times that in
memory), the other channels (measured: about 7 KB together), and the tasks, the mapper and the
provider thread row. The first two are about 180 KiB; the rest is estimated, not measured
piece by piece. The agent process is not counted. **Not
measured** on a live Grok: no agent may start in this step.

## Live proofs for a later step (Grok, cheapest model, behind a flag)

A turn with streamed text; an approval in supervised mode; Stop during a tool call and the
next turn after it (process restart and `session/load`); a model switch; a prompt that fails
(an unknown model); close leaving no process; the Linux cgroup launch.
