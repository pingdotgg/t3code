# conn-provider-codex

The Codex provider for Conn Server. It drives `codex app-server` (JSON-RPC on stdio) and
implements `Provider` and `Session` from `conn-provider`. Reference behaviour:
`CodexAdapterV2.ts` in the Conn monorepo. `PROTOCOL.md` maps the protocol and the event
mapping.

## Layout

| Module     | Holds                                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| `protocol` | JSON-RPC frames; params stay `serde_json::Value`                                    |
| `launch`   | argv, environment, `initialize`, `thread/start`, `turn/start` params, attachments   |
| `context`  | T3's `additionalContext` (`buildCodexAdditionalContext`); texts in `instructions`   |
| `network_gate` | The Orbit MCP network wait before the first spawn (`codexMcpNetworkGate.ts`)    |
| `mapper`   | Pure state machine: frames → `ProviderEvent`s and replies; replay-tested            |
| `client`   | The app-server process shared by the instance's sessions; request ids, routing      |
| `mapper::subagents` | Subagents: `collabAgentToolCall`, `subAgentActivity`, child threads and turns |
| `session`  | `Session`: one native thread per session, a driver task, the 50/400 ms text flushes |
| `text_generation` | `Provider::generate_text`: `codex mcp list`, then `codex exec` (`CodexTextGeneration.ts`) |
| `status`   | The status probe and the `ServerProvider` entry (`checkCodexProviderStatus`), with the model catalog from T3's manifest: the one the server accepted last (`conn_provider::LiveManifest`), else the bundled one (`model_catalog.json`, generated) |

Ids, line framing and the process supervisor come from `conn-provider-support`.

## Process model

One `codex app-server` per provider instance, shared by every session, as the TS server does.
It starts on the first thread call and stops when the last session closes: stdin closed,
SIGTERM to the process group, SIGKILL after 2 s (TS `forceKillAfter`). A session that closes
while others share the process sends `thread/unsubscribe` (TS `unloadThread`). No process
starts once no session is registered. The process gets only what TS sends: `initialize`,
`initialized`, then thread calls (no `model/list`; models come from Codex's model cache). The router sends
each notification and server request to the session that owns its `threadId`. A frame of a
routed thread that names a subagent's child thread (`subAgentActivity.agentThreadId`,
`collabAgentToolCall.receiverThreadIds`) routes the child to the same session from that
frame on; the child's `turn/started` and MCP start-up status that came earlier are kept (at
most 32 frames) and delivered after it. If the process
dies, open turns end as failed, and the next call starts a new process and resumes the thread
(`thread/resume`).

## Launch (matches the TS server)

- **Instance settings:** `CodexProvider::for_instance` builds the provider for one
  `providerInstances` entry (`CodexConfig::with_instance`), as `CodexDriver.ts` 188-221 and
  `createCodexAdapterV2`: `binaryPath` trimmed, `~` expanded, `codex` when empty; `homePath`,
  else a `CODEX_HOME` from the instance's or the server's environment, `~` expanded and made
  absolute, as `CODEX_HOME`; the instance environment (`~` expanded only in `CODEX_HOME`,
  `CLAUDE_CONFIG_DIR`, `GROK_HOME`; a sensitive value is the real one; `Debug` prints names
  only); `launchArgs` trimmed. The server builds one per instance and a new one when the
  entry changes (`conn-server/src/instances.rs`); a session already open keeps its
  app-server. Every instance is listed, as T3 lists it (see "Status probe"); a disabled one
  has T3's disabled entry and starts nothing. `displayName`, `accentColor` and
  `customModels` go on the entry. Not read: `shadowHomePath` and `setupMode` (T3's managed
  home).
- **Executable:** `CodexConfig.binary`, default `codex` on `PATH`, `~` expanded.
- **argv:** `app-server -c thread_unload_delay_secs=0`, then `T3CODE_CODEX_LAUNCH_ARGS` (the
  instance's environment over the server's, as `resolveCodexLaunchArgs` reads the merged
  environment) or `CodexConfig.launch_args`.
- **Environment:** inherited whole. Added: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=T3 Code` (a host
  or instance value wins, as in TS), the instance's own entries, and `CODEX_HOME` when a home
  path is set.
- **`initialize`:** `clientInfo.version` is the pinned `apps/server` version
  (`conn_contract::T3_SERVER_VERSION`, generated; the server descriptor reports the same).
- **Orbit MCP wait:** before the first spawn, up to `T3CODE_CODEX_MCP_WAIT_SECONDS` (120 s)
  for enabled `*.orbit` MCP hosts in `$CODEX_HOME/config.toml` to accept TCP. Nothing is removed, so in
  an Orbit container the variables and `config.toml` that point Codex at the AI router pass
  through. No sign-in call is made.
- **Thread config:** `tools.update_plan.enabled`, `mcp_optional_startup_grace_ms: 10000`,
  `features.concurrent_reasoning_summaries`, and `T3CODE_THREAD_ID` through
  `shell_environment_policy.set`.
- **Turn policy:** per turn, from the runtime mode (table in `PROTOCOL.md`), or the policy's
  `approval_policy` / `sandbox_policy` override (sandbox decoded as TS does), so model, effort
  and mode changes apply on the next turn.
- **Turn context:** with the `conn` MCP server, `additionalContext` carries T3's
  orchestration, runtime and tool text, byte for byte (`tools/gen-instructions.mjs`).
- **Attachments:** a path line per attachment in the text (`attachmentPrompt.ts`), and GIF,
  JPEG, PNG and WebP images inline as data URLs, from `CodexConfig::attachments_dir`.

## Supported

Turns with streamed text and reasoning, token usage, the executed model (reroutes included),
command rows with output deltas, file changes, web search, MCP and dynamic tool rows,
image-view rows, proposed plans, todo lists, context compaction rows, MCP start-up failure
notices, command / file-change / permission / legacy approvals with session allowances,
structured questions, steering, interrupt (with background terminals stopped; a Stop not
confirmed in 10 s reports an interrupt timeout), usage-limit and provider failures (redacted, `conn_provider_support::redact`),
thread resume after a restart, rollback (`CodexThreadRevert.ts`), fork (native, inclusive
`lastTurnId`, or reverted to the boundary; the fork's own model and cwd, as
`codexThreadRuntimeParams`), requests Codex resolved itself
(`serverRequest/resolved`), MCP form elicitations as approvals with the app name and
persistence choices (`CodexMcpElicitation.ts`, in `src/elicitation.rs`). The engine resumes a
thread when its load changes (`thread_load_model_selection` drops the effort, as T3's
`normalizeCodexThreadLoadModelSelection`).

**Subagents** (`src/mapper/subagents.rs`), as `CodexAdapterV2` maps them: a `spawnAgent`
call (v1) or a `subAgentActivity` start (v2) makes a child app thread, a `subagent` node and
row, the child's provider thread and root node, and (v1) the prompt as the child's first
message. The child's turns are turns of their own with the same item handlers; a child's
later turns show what the parent sent; its final answer is the subagent's result; its
running command or tool is the parent row's progress line; `wait`, `sendInput` and
`resumeAgent` calls and `subAgentActivity` ends update the task. An approval a child raises
shows on the root turn under the top-level subagent's node. A child with no reported model
gets T3's read: `thread/read` without turns, else `thread/resume` without turns (5 s). Stop
sends `turn/interrupt` to the root turn, then to each running child turn of its lineage,
waits for all, and ends any lineage turn Codex left open as interrupted; a child turn that
starts under a stopped turn gets `turn/interrupt`. Bounds: 64 subagents per session (the
oldest settled one is forgotten; with none settled a new child is skipped), 64 native turns
per subagent, 16 child threads with early turns, 64 stopped turns.

**Text generation** (`src/text_generation.rs`, `Provider::generate_text`): thread titles
when the title model is this Codex instance, as `CodexTextGeneration.ts` runs them. First
`codex <profile/config launch args> --config features.plugins=false --config
features.apps=false mcp list --json` (10 s; a failure keeps the servers), then `codex exec`
with every enabled MCP server off, the exec launch args, plugins and apps off,
`--ephemeral --skip-git-repo-check -s read-only --model <m> --config
model_reasoning_effort="<e>" [--config service_tier="<t>"] --output-schema <file>
--output-last-message <file> [--image <path>]… -`, the prompt on stdin (180 s; SIGTERM, then
SIGKILL after 1 s). The model is the requested one when the catalog lists it, else one of
its family, else the catalog's first (then the effort is `low` and no service tier goes).
The environment is the server's, the instance's, and `CODEX_HOME`; no originator. The schema
and output files sit in `<tmp>/t3code-codex-{schema,output}-<pid>-XXXXXX/<12 hex>`, removed
after. Errors carry T3's texts ("Codex CLI request timed out.", "Codex CLI command failed:
…", "Codex returned invalid structured output.").

## Not implemented

- **Subagent stop** (`stopTask`) is not built.
- **Capacity continuations** (a turn held for a usage limit, `capacityContinuations`) are not
  built; the wakes below do not wait for one.
- **Text generation:** T3's managed runtime (`resolveRuntime`), custom models
  (`customModels`) and the catalog's `isDefault`/`isLegacy` flags in the model fallback; the
  fallback to another provider when Codex is unusable (in the server's title code).
- **Thread operations:** snapshots, compaction requests, history injection, goals, archive,
  feedback upload; the `additionalContext` restore after compaction (`thread/inject_items`).
- **Retries:** `error` with `willRetry: true` makes no retry row; the turn keeps running.
- **Rate limits:** `account/rateLimits/*` is ignored, so usage-limit failures have no `resetAt`.
- **T3 context details:** browser tools are assumed on (TS reads them from the MCP session);
  device tools follow the session's `device` capability (`McpServer.device_tools`). App context entries go in `additionalContext` as `untrusted`.
  Snapshot window context of image attachments is not added.
- **Tool rows:** MCP presentation (titles, icons, surfaces).
- **Elicitations:** URL elicitations and forms an approval cannot fill are declined, as in T3.
  `item/tool/call` and auth-refresh requests get an error reply.
- **Image generation**, prompt suggestions, async questions in agent messages, and the Linux
  systemd agent scope (see `PROTOCOL.md`, Launch).

## Status probe

`src/status.rs` ports `checkCodexProviderStatus` and `probeCodexAppServerProvider`
(`apps/server/src/provider/CodexProvider.ts`), with `applyCodexModelCatalog` and
`withInstanceIdentity` as `CodexDriver.ts` applies them. Requests, in order:

| Step | Request | Limit | When it fails |
| --- | --- | --- | --- |
| spawn | `<binary> app-server -c thread_unload_delay_secs=0 <launch args>`, the session's environment plus `MISE_OFFLINE=1`, in the server's folder | | `installed: false`, "Could not start Codex CLI (`<binary>`) …" |
| 1 | `initialize` `{clientInfo: {name, title: "T3 Code", version}, capabilities: {experimentalApi: true}}`, then `initialized` | the whole probe: 20 s (`T3CODE_CODEX_PROBE_TIMEOUT_MS` only lengthens it) | "Codex app-server provider probe failed: <error>.", then `codex --version` (4 s) for the version |
| 2 | `account/read` `{}` | | as 1. No account and `requiresOpenaiAuth`: `error`, unauthenticated, "Codex CLI is not authenticated. Run `codex login` …" (with `CODEX_HOME` named when a home is set); nothing more is asked |
| 3, together | `skills/list` `{cwds: [<folder>]}`; `model/list` `{}` then `{cursor}` per page (a ChatGPT account: again once `models_cache.json` has a `fetched_at` after the spawn, polled every 100 ms for up to 3 s); `config/read` `{includeLayers: false}` (3 s) | 250 ms before the probe's limit | skills or models fail: as 1. Models late: `warning`, "Codex did not return its model catalog in time." Config fails: no config |
| 4 | `account/rateLimits/read` `null`, only when the config routes to OpenAI itself and the account is not an API key | as 3 | `usageLimits` unavailable, `probeFailed`, with T3's text |
| end | stdin closed, SIGTERM to the group, SIGKILL after 2 s; the probe waits for it | | |

A probe that passes the 20 s gets "Timed out while checking Codex app-server provider
status." The entry: T3's pending one before the first probe ("Codex provider status has not
been checked in this session yet."), then `ready` (or `error` signed out), the version from
the `userAgent`, the account as `auth` (type, plan label, email, workspace; never a token),
the router's origin as `auth.endpoint` when the config routes elsewhere, the models with
their reasoning, service tier and cyber access options, T3's preferred default, the
configured service tier and Daybreak program, `customModels`, the catalog's legacy marks and
`updateRequiredModels`, the skills, and the `/compact`, `/goal` and `/feedback` commands.

It runs as the server's other probes do (`conn-server/src/methods/provider.rs`): at start, on a
settings change (an instance is rebuilt then), on `server.refreshProviders`, and every 5
minutes only while a client in the foreground asks for provider status. A disabled instance is
never probed. `CONN_CODEX_STATUS_PROBE=off` keeps the pending entry (every check that starts a
server sets it). One probe at a time per instance.

Cost (macOS, release, stub CLI): about 40 ms, and the server's RSS 11.7 MiB after the probe
against 11.4 MiB with it off; no Codex process is left after it. The real CLI adds its own
start and, for a ChatGPT account, up to 3 s for its catalog refresh, for one short-lived
`codex app-server` process (not measured: no check runs the real CLI).

Proof: `tools/probe-conformance/run.mjs` (in `tools/check.sh`) runs T3's own function and
ours against a stub `codex` (`stub-codex.mjs`) in 17 scenarios: disabled, missing binary (a
path and a bare name on a PATH without it), an old CLI without `app-server`, a hang, a failed
`initialize`, signed out with and without a home, ChatGPT with and without the cache refresh,
an API key with custom models, Orbit's router, a failed `skills/list`, a model list that
never answers, a failed usage read, and an instance with a `~` binary, launch arguments from
its environment, a sensitive variable and an identity. All equal: the entry, and per run the
argv, environment, folder, every stdin line (ids aside; the concurrent reads after
`account/read` grouped by method, since their order is timing on both sides) and the signals
it got. Both sides are
sealed (T3's in `sealedNodeEnv` with the fetch guard; both probe with `PATH=/usr/bin:/bin`).
`check-copies.mjs` holds the plan and effort labels and the preferred default models;
`gen-model-catalog.mjs --check` the catalog.

Not ported, on purpose: the version advisory (a registry lookup), the managed setup mode and
shadow homes, and the watch on `auth.json` that probes again after `codex login` outside T3
(the next probe shows it). Known difference: T3's client checks every answer against Codex's
schema and fails the probe on one that does not fit ("protocol operation
'decode-response-payload' failed"); ours reads the fields it needs and tolerates the rest.
Also: our stderr tail for the exit message keeps 4 KiB, T3's 8 KiB (the excerpt is the last
error line, so only a stderr with more than 4 KiB after that line differs).

## A Stop that abandons a start, and a turn that still starts (deliberate difference)

Nick decided on 2026-11-15: when a Stop abandons a start whose `turn/start` was already
written, and Codex started the turn anyway, that turn is stopped. The T3 server leaves it
running unobserved (see `docs/status.md`, "Faults found in the T3 server").

- Before `turn/start` is written: as T3, the start stops at the request it waits on and sends
  nothing more.
- After: the answer goes to a watcher (bounded by `CodexConfig::abandoned_start_timeout`, the
  request's 60 s). When the answer or a `turn/started` names the turn, Codex gets
  `turn/interrupt` for it, once. None of that turn's frames become events: no new run, no
  subagent turn, nothing in the next turn. Its `turn/completed` ends it.
- The next start on the thread waits until the abandoned start settled (no turn in the
  answer, or its turn ended), at most the answer's limit plus the Stop confirmation's 10 s;
  then it goes ahead and the abandoned turn's id stays among the ended turns.
- Nothing ever arrives: nothing is sent; after the limit nothing is kept.
- The session closes first: close does not wait. The last session stops the process, and the
  answer never comes; with a shared process, a late answer still gets `turn/interrupt`.
- A `turn/started` that came before the Stop gave the run its turn: the start counts as
  accepted, and the engine stops it as a turn accepted after Stop.

What Codex receives that T3 does not send: one `turn/interrupt {threadId, turnId}` for such a
turn. Tests (`src/live_tests.rs`, a fake app-server, no CLI):
`an_abandoned_start_before_turn_start_sends_nothing_more`,
`a_late_answer_to_an_abandoned_start_interrupts_its_turn`,
`a_turn_started_for_an_abandoned_start_is_interrupted`,
`an_abandoned_start_that_never_answers_sends_nothing_and_ends`,
`the_next_turn_waits_for_an_abandoned_start_that_reached_codex`,
`closing_the_session_ends_an_abandoned_start`.

## Wakes: work that ends after its turn (2026-11-15)

As `CodexAdapterV2` asks `ProviderContinuationRequests` for a continuation turn, this crate
emits `ProviderEvent::ContinuationRequested`, and the engine queues the wake message
(`queue_after_active`: it runs after any active run and before nothing queued earlier; a
released session opens again for it, as for any message). Both wakes carry `delivery:
"message_text"`: the text is the whole wake, so the engine creates the message as the
server's (`creationSource: "server"`), and the wake turn sends that text to Codex as an
ordinary `turn/start`.

- **A subagent that ends after its root turn** (`finalizeCodexTurn`): a direct child whose turn
  completes or fails while no root turn runs on its parent thread, and whose root turn was not
  stopped or failed. Text (`codexNativeSubagentDetail`): `Subagent <status>: <title, else
  prompt, else id>`, then `\n\nResult:\n<result>` when the child answered. Notice:
  `backgroundWorkNotification` for the subagent, with its child thread.
- **A background command that ends after its turn**: a completed root turn with running
  commands is kept (`settledTurns`, at most 16) while they run; their output deltas and end
  still show. When one ends, and the turn is not being stopped, one wake per command
  (`codexBackgroundCommandDetail`: `Background command completed (exit N): <command, 200
  UTF-16 units>` and the last 1,000 units of its output; the notice names the command, its
  outcome and exit code, with the command as `detail`). `thread/closed` ends a settled turn's
  commands as interrupted, with no wake. A root turn's command rows carry `completionWake:
  "always"`, as T3's; the replay compares it now.

The notice text is `conn_provider_support::notification`, shared with Claude. Proof:
conformance scenarios `subagentWake` and `commandWake` (T3's recordings with the child or the
command moved behind the root turn's end, and a wake turn; T3's adapter offers are logged and
compared with our events: text, notice, delivery; both servers send the same wake
`turn/start`), `idle-diff` (the "background work ended" state is the same as T3's), the
replay of all 21 recordings with `completionWake`, unit tests
`a_command_that_ends_after_its_turn_wakes_the_agent_once`,
`a_stopped_turns_command_asks_for_no_wake`, `a_closed_thread_ends_a_settled_turns_commands`,
`a_subagent_wakes_its_parent_only_after_a_completed_root_turn`, and the engine's
`a_message_text_wake_is_the_servers_message`.

## Known differences from `CodexAdapterV2`

- A turn whose start Stop abandoned is stopped when it reaches Codex anyway (above).
- `turn.terminal` has no `failureItemOrdinal` or `retryStartedAt`: the trait has no field.
- Capabilities switch off what is listed above.

## Stop that Codex never confirms

As T3 since b5b470542a: when Codex does not end the turn within 10 s of `turn/interrupt`
(`CodexConfig::stop_confirm_timeout`, T3's `CODEX_STOP_CONFIRM_TIMEOUT_MS`), the turn stays
open and marked interrupting, and `interrupt_turn` returns
`ProviderError::InterruptTimeout`. A later `turn/completed` ends it as usual; closing the
session (Force stop) ends it as interrupted. The engine marks the Stop unresponsive and clients
offer Force stop. Proof: `an_unconfirmed_stop_times_out_and_keeps_the_turn_open`.

## Version tie

The crate reads the few fields it uses by name and tolerates new ones. Unknown methods and
items are skipped and logged once each. `TESTED_CLI_VERSION` (0.167.0) names the release
whose printed schema was checked (the installed CLI); the T3 server manages 0.166.0 at the
pinned commit (`CodexInstallation.ts`), and the recordings come from 0.156.1 (25 of 28),
0.157.0 (`command_output_streaming`), 0.124.0-alpha.3 (`thread_fork_native_prior_turn`) and
0.120.0 (`delegated_task_status`); a newer minor version logs a warning at start-up. When the
CLI changes a field the mapper reads, the replay tests do not notice; the live tests do.

Typed upstream definitions were measured and not used:

| Option                                        | State (2026-11-13)                                                                                                            | Cost                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `codex-app-server-protocol` in `openai/codex` | Apache-2.0, not published (workspace version 0.0.0); depends on rmcp, zstd, uuid, tracing and seven internal crates           | not vendorable at small cost                                  |
| `codex-app-server-protocol` on crates.io      | a third-party republish, 0.63.0, December 2025                                                                                | a year behind the CLI                                         |
| `codex-codes` on crates.io                    | Apache-2.0, third party, 0.167.8 (tracks the CLI's version), released daily, 32k downloads; serde types, unknown methods kept | decoded all 3,372 recorded frames; +1.0 MB in a release probe |
| hand-written reads of `Value` (this crate)    | ~20 fields                                                                                                                    | crate code 81 KB                                              |

## Tests

```sh
node crates/conn-provider-codex/tools/conformance.mjs  # the wire check
node crates/conn-provider-codex/tools/gen-instructions.mjs --check
node crates/conn-provider-codex/tools/gen-model-catalog.mjs --check
node crates/conn-provider-codex/tools/probe-conformance/run.mjs
cargo test -p conn-provider-codex                                                # offline
cargo test -p conn-provider-codex live_ -- --ignored --test-threads=1 --nocapture  # real CLI
node tools/capture-ts-events.mjs   # regenerate testdata, offline
```

- `tools/conformance.mjs` (in `tools/check.sh`) proves the launch and the wire equal to the
  T3 server's. A stub `codex` (`tools/codex-stub.mjs`) records argv, environment, every stdin
  line and the shutdown signals, and replays a recording. The same scenarios run through the
  T3 server's real `CodexAdapterV2` spawn path and through this crate
  (`examples/conformance.rs` replays the TS adapter's calls). It compares argv, the
  environment, every frame, shutdown order and timing, and rollback and fork answers; for
  every fixture with a Codex recording it also asserts each `expect_outbound` frame with the
  TS replay driver's normalization. `elicitation` runs T3's approval recording with the
  command approval swapped for a form elicitation. `login` starts each side with a stand-in
  login shell (TS: `fixPath`; Rust: the start-up `hydrate`) and checks the `codex` found on its
  `PATH` and the `PATH`, `__MISE_DIFF` and `JAVA_HOME` the child got. A subagent's model
  reads are compared as a set (both servers send them from a background task; T3's test kit
  answers them, so recordings never hold them). `subagentStop` cuts T3's `subagent_v2`
  recording after the child's turn started and stops the run: both send `turn/interrupt` to
  the root, then the child. `titleListed` and `titleFallback` run T3's own
  `makeCodexTextGeneration().generateThreadTitle` and our `generate_text` (with T3's prompt
  and schema): the `mcp list` and `exec` argv (temp files compared by their shape),
  environment, folder, stdin bytes, schema file and answer must be equal. Known differences
  are listed in it with their reason. `instanceSettings`, `instanceLaunchEnv` and
  `titleInstance` give both sides the same `providerInstances` entry (launch args; an
  environment with a plain, a sensitive and an originator value; `T3CODE_CODEX_LAUNCH_ARGS`
  from the instance; a title with an instance environment). A `~` binary path is not run
  there: the check keeps the shell's `HOME`, so it would point into the real home; a unit
  test and the server's `instances-flow.mjs` (`homePath` with `~`) cover the expansion.
  Rerun on every Codex CLI or pinned-commit change.
- `src/replay_tests.rs` replays 21 of the TS test kit's 25 Codex recordings (all that do not
  need rollback, fork or a transformed transcript; the six subagent recordings included) and compares every event with
  the TS adapter's output for the same lines, after the normalizations listed there. Replies
  to approvals and questions must equal the recorded frames.
- `session::tests` drives a whole session against a scripted fake app-server: a turn, an
  approval, an interrupt, close and process exit.
- The live tests use `gpt-6-luna` in a temporary folder.
