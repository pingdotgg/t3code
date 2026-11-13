# conn-mcp

`/mcp` for the Conn Server: the T3 tool server that agents inside a thread, and outside callers
such as Orbit's Swamp, call over MCP. The T3 server (`apps/server/src/mcp/McpHttpServer.ts`) is
the reference; this crate is our own implementation on the `Engine` trait.

| Path                              | Holds                                                             |
| --------------------------------- | ----------------------------------------------------------------- |
| `src/transport.rs`                | Streamable HTTP, JSON-RPC, MCP sessions                           |
| `src/credentials.rs`              | Agent tokens per provider session                                 |
| `src/catalog.rs`, `catalog.jsonl` | The T3 tool definitions we serve, generated; argument checks      |
| `src/tools/`                      | The handlers: threads, tasks, projects and environment            |
| `src/view.rs`                     | Engine rows shaped as the tool results                            |
| `tools.implemented`               | The tools we serve, one per line                                  |
| `tools/gen-tools.mjs`             | Writes `catalog.jsonl` from `apps/server`; `--check` finds drift  |
| `tools/parity.mjs`                | Same calls on the T3 server and the Conn Server; compares results |
| `fixtures/ts-tools-list.json`     | A live T3 server's `tools/list` (80 tools, outside caller)        |

The route is `crates/conn-server/src/routes/mcp.rs`; `serve.rs` builds the service.

## Transport

Measured on a live T3 server at the pinned commit (`tools/mcp-client.mjs` drives both servers).

- One endpoint, `POST /mcp`, protocol **2025-06-18**. Any `initialize` version gets 2025-06-18,
  as the T3 server answers. The T3 server also serves sessionless 2026-07-28; no T3 caller uses it.
- **Sessions:** `initialize` returns `Mcp-Session-Id`. Every later request names it: missing →
  400 with JSON-RPC `-32600` (`MCP-Session-Id header is required…`), unknown → 404, `DELETE` → 204. Ours are bound to the credential that opened them, capped at 256, idle after 24 h.
- **No SSE.** Replies are one JSON body with `content-type: application/json` and a
  `mcp-protocol-version` header; notifications get 202. `GET` is 405 (`allow: POST, DELETE`).
- Checks in the T3 order: auth 401, an `Origin` header 403, a content type other than JSON 415,
  an `Accept` without both `application/json` and `text/event-stream` 406, a bad body `-32700`,
  a JSON-RPC batch 400, an unknown `mcp-protocol-version` 400 (`-32022`).
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `logging/setLevel`; others `-32601`.
  `tools/list` is not paged and never changes, so no `list_changed` is sent.
- `tools/call`: success is `{content: [text JSON], structuredContent, isError: false}`; a tool
  failure is `{content: [text OrchestratorMcpFailure JSON], isError: true}`; an unknown tool,
  an undeclared argument, a missing key, or a wrong type is JSON-RPC `-32602`
  (`Invalid parameters for tool 'X': Unknown argument "y". Accepted arguments: …`). `null` for an
  optional argument counts as omitted. `environmentId` other than this environment's is
  `capability_denied`, as the T3 server answers with linked environments off.

## Auth

| Caller            | How it authenticates                                                                             | Scope                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Agent in a thread | `Authorization: Bearer <token>` from `McpService::issue_thread_credential`                       | Acts as its thread: default target, modes capped at the thread's |
| Outside client    | An environment bearer session (paired device, `t3 auth session issue`) with `orchestration:read` | `orchestration:operate`: any runtime mode; else read-only        |

- Agent tokens: 32 random bytes, hex, stored as SHA-256 per provider session; valid while used
  at least once in 24 h (`touch_thread` renews); revoked per thread or provider session; at
  most 1024. This is `McpSessionRegistry.ts`.
- **Differs from the T3 server.** There an outside caller needs an MCP OAuth client token
  (`/oauth/mcp/*`, approved with a pairing code that carries an access level), and an
  environment session is refused with 401. The Conn Server has no MCP OAuth. Orbit's planned
  Swamp driver authenticates with an `Orbit Swamp` session from `t3 auth session issue`, which
  the T3 server would refuse here; a session that may already drive threads over `/ws` gains
  nothing new on `/mcp`. Not served: `T3-Mode-Limit`, `T3-Sender-Thread`, linked environments.
- 401 carries `www-authenticate: Bearer` and no `resource_metadata`, so no agent starts a sign-in.

## Tools

The T3 server registers 84 tools (`gen-tools.mjs --all`). Context filters: `tool_search` is listed
only to clients that send `t3-tool-exposure: deferred`; `t3_environment_link(s)`/`unlink` are
hidden while linked environments are off; `watch_pull_request`/`unwatch_pull_request` are hidden
from delegated children. Preview, device and panel tools are listed to everyone and fail without
the capability.

**Served (16)**, definitions byte for byte from `apps/server`:

| Group        | Tools                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Orbit's set  | `t3_project_list`, `t3_thread_launch`, `t3_thread_send`, `t3_thread_wait`, `t3_pending_request`, `t3_thread_read`, `t3_thread_interrupt` |
| Threads      | `t3_thread_list`, `t3_thread_update`, `t3_thread_search`                                                                                 |
| Delegation   | `delegate_task`, `task_status`, `task_cancel`, `orchestrator_capabilities`                                                               |
| Project, env | `t3_project_read`, `t3_environment_read`                                                                                                 |

Where they differ, because the engine does not do it yet:

- `t3_thread_send` starts a run on an idle thread; `restart` interrupts and starts. Queue and
  steer onto a running thread answer `thread_not_sendable`. `freshContext` is refused.
- `t3_thread_launch`: `root` and `existing_worktree` only; no `scratch`, no attachments. The thread
  is recorded as `createdBy: user` (the engine's `launch` sets it). Without `modelSelection`
  a client gets the first ready provider's first model.
- `t3_thread_wait` ends on `waiting` too, as Orbit's driver expects; no restart chains, since the
  engine ends a run on restart.
- `t3_thread_update`: `rename` only. `t3_thread_search`: title, branch, project title, then
  message text, no ranking.
- Delegation: the child is a top-level thread, id derived from parent and task id, so no task
  table and restarts are safe; the engine has no `lineage` on `thread.create` yet, so clients do
  not nest it. Async tasks wake the parent with the T3 wake text once the parent is idle; that
  watcher lives in memory. No `isolation: worktree`, no remote targets, no result acknowledgement.
- `orchestrator_capabilities`: no option descriptors, favourites or model preferences.
- Results keep the TS keys; serde_json sorts keys, so the `text` copy orders them differently.

**Not served (68)**, so not listed: an unknown tool is `-32602 Tool 'x' not found`, as the T3
server answers a hidden one.

| Area          | Tools                                                                                                                                                                                                                                                                                  | Why                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Desktop       | `preview_*` (13), `t3_preview_list/close`, `device_*` (4), `panel_open`, `html_preview`, `html_render`, `request_credentials`, `fill_credential`, `save_test_login`, `database_query`, `mcp_connect`, `mcp_call`                                                                       | Need the desktop browser, devices or panels    |
| Other tracks  | `link_*`/`unlink_*`/`list_thread_pull_requests`, `watch_`/`unwatch_pull_request`, `*_pull_request_guide(s)`; `schedule_task`, `list_`/`delete_scheduled_task`, `run_scheduled_task_now`; `t3_worktree_*`, `t3_project_create/update/delete/clone`, `t3_environment_preferences_update` | Pull requests, schedules, VCS, files, settings |
| Engine        | `create_threads`, `t3_thread_configure`, `t3_thread_transfer`, `t3_thread_organize`, `t3_queue`, `t3_attachment_*`, `t3_thread_send_attachments`, `t3_workflow_stop`, `t3_background_wait`, `request_secret`, `annotations_*`                                                          | Need engine commands not built yet             |
| Links, search | `t3_environment_link(s)`, `t3_environment_unlink`, `tool_search`                                                                                                                                                                                                                       | No linked environments; no deferred clients    |

To serve one: add its name to `tools.implemented`, run `gen-tools.mjs`, add a handler in
`src/tools/` and its name to `HANDLED`; the tests check both lists agree.

## What Orbit needs

From Orbit `origin/main` at `77f6bf5c22` (read by ref; the local checkout is older).

- **MCP (planned Swamp `t3` driver)** — `docs/reference/development-containers.md`, "Swamp drives
  T3": `POST <url>/mcp`, `Authorization: Bearer <Orbit Swamp session>`; `t3_project_list` (the
  project at `/srv/workspace`); `t3_thread_launch` (`projectId, title, message, modelSelection
  {instanceId, model, options:{effort}}, runtimeMode: full-access, interactionMode: default,
  workspaceStrategy:{type: root}, clientRequestId: operation-<id>`); `t3_thread_send`
  (`threadId, message, mode: queue, clientRequestId`); `t3_thread_wait` (`threadId, runId,
  timeoutMs`); `t3_pending_request` (`action: read`); `t3_thread_read` (`view: activity`,
  `afterPosition`); `t3_thread_interrupt` (`threadId, runId`). A retried launch or send with the
  same `clientRequestId` and session must return the same run. No code calls `/mcp` yet.
- **WebSocket** — `swamp/extensions/behaviors/operations/conn-revocation/read_sessions.ts:22-76`:
  `/ws?orchestrationProtocol=2` with a bearer header, `subscribeAuthAccess`, first snapshot only.
  Planned (doc): `/api/auth/websocket-ticket`, `orchestration.getThreadProjection`,
  `orchestration.forceStopThread`.
- **HTTP** — `GET /.well-known/t3/environment` (readiness, 30 × 1 s, `instance-container-phase.yml:866`;
  `HttpT3ServerClient.php:56`); `GET /api/auth/session` (`:72`, `instance-container-phase.yml:922`);
  `POST /api/auth/pairing-token` with `{label, scopes}` (`workflow-operation-conn-pairing-create.yaml:86`);
  `POST /api/auth/clients/revoke` and `/api/auth/pairing-links/revoke` (`workflow-operation-conn-pairing-revoke.yaml:148,197`).
- **CLI** — `t3 project add /srv/workspace --title <t>` (stdout: the project id only,
  `instance-container-phase.yml:893`); `t3 auth session issue --label "Orbit Gateway"|"Orbit Swamp"
  --token-only` (stdout: the token only, `:917`).
- **Start** — `t3 serve --host=0.0.0.0 --port=3773 --no-browser` as `agent`, state in
  `~/.t3/userdata`, `settings.json` merged with `linkedEnvironmentsEnabled: true`
  (`apps/gateway/app/Domain/Instances/InstanceImage.php`, `InstanceContainer.php:291,304`).

## The SDK or our own

Measured 2026-11-13 against `rmcp` 3.10.0, the official SDK (released 2026-11-12, 28 M recent
downloads; protocols 2024-11-05 to 2026-07-28; a tower `StreamableHttpService` that fits axum and
a one-thread runtime). Both builds serve the same handlers; only the transport differs (the SDK
build is commit `35cfdba72b`). macOS arm64, release profile, `ps` RSS and `footprint`:

| Build         | Binary  | Idle            | 1 session    | +100 sessions |
| ------------- | ------- | --------------- | ------------ | ------------- |
| Before `/mcp` | 5.02 MB | 4.8 MB / 2.0 MB | —            | —             |
| Ours          | 5.31 MB | 4.9 MB / 2.1 MB | 5.7 / 2.6 MB | 6.5 / 3.4 MB  |
| `rmcp`        | 6.24 MB | 5.2 MB / 2.0 MB | 7.5 / 3.8 MB | 18.8 / 15 MB  |

`rmcp` brings 29 crates of its own (futures, schemars, chrono, tracing, tokio-util, uuid, ...), 0.94 MB, and
about 0.12 MB per open session: each session runs a worker task with its own channels until 5
idle minutes pass. Agents keep a session per CLI process and Swamp may open one per step, so that
is the cost that grows. It also always answers over SSE. Ours is about 300 lines (`transport.rs`,
`sessions.rs`). We keep ours. Revisit when T3 moves to a protocol revision we do not serve;
`35cfdba72b` shows the SDK wiring.

## Checks and drift

- `cargo test -p conn-mcp` (offline, the engine's fake provider): the transport statuses; Swamp's
  flow including idempotent launch and send; read-only clients; an agent's credential, its
  delegated task and its wake; every result checked against the tool's TS `outputSchema`; the
  catalog equal to `fixtures/ts-tools-list.json`; bounded credentials and sessions.
- `node native/conn-server/crates/conn-mcp/tools/gen-tools.mjs --check`: the served definitions
  still match `apps/server`. The nightly upstream merge runs it; on failure, rerun without
  `--check`, read the diff, and fix the handler if a schema changed.
- `node native/conn-server/crates/conn-mcp/tools/parity.mjs native/conn-server/target/debug/examples/replay_server`:
  both servers on throwaway state, same inputs, outcomes and result shapes compared. One Haiku
  turn on the T3 server.
- The tools take the Conn monorepo root from `CONN_MONOREPO` (`tools/monorepo.mjs`), default the
  checkout they sit in.

## Agent wiring

`McpService::issue_thread_credential(ThreadCredentialRequest { thread_id, provider_instance_id,
subagent })` returns an `McpServerEntry { url, authorization, .. }` for one provider session:

- Claude: `entry.claude_server()` is the `mcpServers["t3-code"]` value (`type: http`, `url`,
  `headers.Authorization`, `timeout` 65 min); `entry.claude_mcp_config()` is the whole
  `--mcp-config` JSON. Pre-approve `mcp__t3-code__*` as the T3 adapter does.
- Codex: `entry.codex_config()` gives `mcp_servers.t3-code` (wait tool disabled) and
  `mcp_servers.t3-code-direct` (only `t3_thread_wait`, out of code mode), each with `url`,
  `tool_timeout_sec` and `http_headers.Authorization`.
- Call `revoke_provider_session` when the session ends and `touch_thread` when a turn starts.

`crates/conn-server/examples/mcp_agent.rs` proves it: it serves one thread and writes that
thread's `--mcp-config`, and `claude -p --model claude-haiku-5-5 --strict-mcp-config
--mcp-config <file>` listed threads, launched one and waited for it.
