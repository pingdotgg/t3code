# Scheduled tasks and the Conn-only areas: the map

What the T3 server does in each of these areas, where its state lives, and what each method
and tool needs from outside the server. The order of work follows the "Needs" column: what a
server can do alone comes first. `crates/conn-features/README.md` says what the Conn Server
serves of it today.

Source: the T3 server in the monorepo (written at Conn `b12470dcad`). `S/` means `apps/server/src/`, `C/` means
`packages/contracts/src/`, M the monorepo root. Scopes come from
`crates/conn-server/src/scopes/generated.rs`. "unconfirmed" marks what was not verified.

## Scheduled tasks (8 methods, 4 tools)

| Name | T3 handler | What it does | State | Scope or access | Needs |
| --- | --- | --- | --- | --- | --- |
| scheduledTasks.subscribe (stream) | S/ws.ts:2295 | The list and the server's time zone, again after each change | SQLite `scheduled_tasks` | orchestration:read | nothing |
| scheduledTasks.upsert | S/ws.ts:2297 | Creates or edits a task; keeps the next run when the schedule is unchanged | same | orchestration:operate | nothing (a thread check reads the engine) |
| scheduledTasks.setEnabled | S/ws.ts:2298 | Pauses or resumes; plans the next run from now | same | orchestration:operate | nothing |
| scheduledTasks.delete | S/ws.ts:2302 | Removes a task and its webhook deliveries | same | orchestration:operate | nothing |
| scheduledTasks.runNow | S/ws.ts:2306 | Runs a task at once: a new thread, or a queued message in its bound thread | same | orchestration:operate | engine |
| scheduledTasks.rotateWebhookToken | S/ws.ts:2310 | New URL token for a webhook task | same | orchestration:operate | nothing (served here; the relay is not built) |
| scheduledTasks.listWebhookDeliveries | S/ws.ts:2322 | The logged webhook requests of a task | SQLite `scheduled_task_webhook_deliveries` | orchestration:operate | nothing (served here) |
| scheduledTasks.getWebhookDelivery | S/ws.ts:2326 | One logged request with headers, body and rendered prompt | same | orchestration:operate | nothing (served here) |
| schedule_task | S/mcp/toolkits/orchestrator/handlers.ts:88 | Creates (`startsThreads`) or with `scheduledTaskId` updates (`writes`) a task | as above | `either(startsThreads, writes)` | engine |
| list_scheduled_tasks | same file:125 | The caller's project's tasks, or all outside a thread | as above | `reads` | nothing |
| delete_scheduled_task | same file:132 | Deletes a task the caller may change | as above | `writes` | nothing |
| run_scheduled_task_now | S/mcp/toolkits/thread/handlers.ts:94 | Runs a task now; returns its thread | as above | `writesEnvironment` | engine |

Facts: the T3 server polls every 5 s (`S/scheduling/Scheduler.ts`) with a due hint that skips
SQL while nothing is due (`DueHint.ts`, 10 minute backstop). Minimum interval 60 s. A fixed time
more than 10 minutes late is skipped and recorded as missed. A run left `running` by a stop is
recorded as failed at start. A recurring run is skipped while an earlier copy still waits in
its bound thread's queue. Run ids: `scheduled-task:<id>:<startMs>:<trigger>` and
`scheduled-task-message:<...>`. Webhooks: 60 requests a minute per task, 20 queued per task,
50 + 20 + 20 deliveries kept per task, bodies logged up to 64 KiB with secret headers and query
values redacted (`S/scheduledTasks/ScheduledTaskService.ts:82-92`). The signing secret is
stored in the `scheduled_tasks` row (`webhook_secret`), in clear text. This server serves the
three webhook methods and the route (`crates/conn-features/README.md`, "Webhook tasks").

Rules used for the tables:

- **Needs** is one of `nothing`, `engine`, `desktop client`, `other Conn server`, `outside service`. When two apply, the table names the later one in this list and says both in the "does" column.
- For MCP tools, the caller gate in `S/mcp/McpToolAccess.ts` (finds the calling thread, checks modes) is not counted. A tool counts as `engine` only when its work uses threads, turns or projects beyond that gate.
- "T3 handler" is the file:line where the T3 server answers the tag or tool.

## Settings secrets (the T3 server's secret store)

Every secret a `ServerSettings` field holds. The T3 server keeps the value in its secret store,
`<state>/secrets/<name>.bin` (`S/auth/ServerSecretStore.ts`: folder 0700, file 0600, a temp
file `<name>.bin.<uuid>.tmp` and a rename), and `settings.json` holds `••••••` in its place.
`e(x)` is base64url of the UTF-8 text without padding; `host` is a server host, trimmed and
lowercase. Names come from `mapSecretFieldGroups` (`S/settingsSecrets.ts`) and
`sourceControlHostSecretName` (`S/sourceControl/sourceControlHostSecrets.ts`).

| Settings field | Store name |
| --- | --- |
| `providerInstances.<id>.config.<field>` (OpenCode `serverPassword`, Antigravity `apiKey`) | `provider-config-e(id)-e(driver)-e(field)[-e(host)]` |
| `providerInstances.<id>.environment[]` with `sensitive: true` | `provider-env-e(id)-e(name)`; the file holds `value: ""` and `valueRedacted: true` |
| `sourceControlHosts.<kind>.<field>` (GitHub `tokens` and `signIns` per host) | `source-control-e(kind)-e(field)[-e(host)]` |
| `usageLimitSources.<id>.managementKey` | `usage-limit-source-e(id)` |
| `textGenerators.<id>.apiKey` | `text-generator-e(id)-e("apiKey")` |
| `cloudSpeechCredentials.<openai, xai, openrouter>` | `voice-cloud-<field>` (not encoded) |
| `easDeviceHosts[].accessToken` | `device-host-e(id)-e("accessToken")` |
| `simlockDeviceHosts[].agentToken` | `simlock-device-host-e(id)-e("agentToken")` |

- **When a value moves.** At start, a field secret that `settings.json` holds as a value moves
  to the store and the file gets the marker (`moveInlineSettingsSecrets`); a value that cannot
  be stored stays inline. A sensitive variable moves at the next save, not at start. On a save
  (`persistSettingsSecrets`): a new value is written and the slot gets the marker; the marker
  keeps the stored value; an empty slot, a variable no longer sensitive, or a slot that is
  gone removes the stored value. A failed store or file write undoes the store changes.
- **What a client sees.** `••••••` for a saved field secret (also for a secret provider
  reference, to a client without `secretReferences`), `""` with `valueRedacted: true` for a
  saved sensitive variable, `""` when nothing is saved (also a marker whose file is gone). A
  client that sends the marker back keeps the stored value.
- **A reference** (`{ provider, reference }`) is not a secret: it stays in `settings.json`.
- **This server** (since 2026-11-14) does the same, in `crates/conn-server/src/settings/secrets.rs`
  with `conn_support::secret_store`. The settings it hands its own code (`SettingsStore::raw`)
  hold the values read from the store, kept in memory as before. Before, it kept every value
  in `settings.json` (0600). Both servers can read and write the same state folder:
  `crates/conn-server/tools/secrets-interop.mjs` runs the T3 server's own settings service and
  this server on shared folders (a folder from before the change, saves by either server, a
  key used for a text generator request) and checks that no value is lost or left in the file.
- **Who can read a value.** The OS user that runs the server (and any process of that user,
  such as an agent's shell): the files are 0600 in a 0700 folder, in clear text, as in T3.
  No client can: no method returns a settings secret.

## Finding that changes the plan

At this pin the T3 server mounts only `annotations.subscribe`, `annotations.create` and `annotations.remove` from the Conn-only RPC group (`S/wsFork.ts:9-13`; `M/FORK.md:1126-1139`). `credentials.*`, `testLogins.*` and `panels.*` are declared in `ForkWsRpcGroup` (`C/rpc.ts:2329-2342`) but have **no handler**. FORK.md:1138: "`credentials*`, `testLogins*` and `panels.*` remain unmounted. Do not broaden this allowlist". `S/wsMountedRpc.test.ts:8-10` enforces a three-method allowlist. What a client sees for an unmounted tag is unconfirmed. The logic behind them exists as services (`TestLoginStore`, `CredentialAutofill`, `AgentPanelBroker`) and the MCP tools use it, so the table cites those lines.

Consequence: with no mounted `panels.requests` stream, `AgentPanelBroker.show` always fails with reason `no_desktop` on the T3 server at this pin (`S/panels/AgentPanelBroker.ts:92-97`) unless a client reaches the broker some other way (unconfirmed). So `panel_open`, `database_query`, `mcp_connect`, `mcp_call` cannot succeed against the T3 server as mounted.

## RPC methods and streams (24)

| Tag | T3 handler | What it does | State | Scope | Needs |
| --- | --- | --- | --- | --- | --- |
| annotations.create | S/wsFork.ts:29 -> S/annotations/AnnotationStore.ts:346 | Creates an annotation, or edits one with the same id (keeps number, status, createdAt). Decodes an optional base64 screenshot to a file. Rejects an id that was removed. | Files `<stateDir>/annotations/<projectId>/<id>.json`, `<id>.<png|jpg|webp>`, `_sequence.json`, `_deleted.json` (AnnotationStore.ts:33-35, 141-145). Also an in-memory map per project. | preview:operate | nothing |
| annotations.remove | S/wsFork.ts:33 -> AnnotationStore.ts:396 | Removes by `ids`, or `scope` `done` (all done) or `idle` (all not in progress), or all when neither is given. Writes `_deleted.json` first. | same files | preview:operate | nothing |
| annotations.subscribe (stream) | S/wsFork.ts:28 -> AnnotationStore.ts:332 | Sends the full list on subscribe, then the full list after every change. | same files + in-memory PubSub (sliding, size 1) | orchestration:read | nothing |
| panels.requests (stream) | no handler (unmounted). Logic: S/panels/AgentPanelBroker.ts:62 | A desktop subscribes; each agent panel request goes to every subscriber. | Memory only: `subscribers` map, unbounded queue per subscriber (:57, 65) | preview:operate | desktop client |
| panels.respond | no handler (unmounted). Logic: AgentPanelBroker.ts:76 | A desktop answers a request. First `ok` answer wins. A failure counts down; the last failure answers the agent. Unknown id is ignored. | Memory only: `pending` map | preview:operate | desktop client |
| testLogins.list | no handler (unmounted). Logic: S/credentials/TestLoginStore.ts:174 | Returns test logins as summaries (no password, no otp secret). | `<stateDir>/secrets/test-logins.bin` | settings:write | nothing |
| testLogins.save | unmounted. TestLoginStore.ts:119 | Adds a login (`createdBy` "user" over RPC; MCP uses "agent"). | same file | settings:write | nothing |
| testLogins.update | unmounted. TestLoginStore.ts:140 | Patches a login. `otpSecret: null` removes the code secret. | same file | settings:write | nothing |
| testLogins.remove | unmounted. TestLoginStore.ts:159 | Deletes a login. | same file | settings:write | nothing |
| testLogins.reveal | unmounted. TestLoginStore.ts:166 | Returns `{password, otpSecret}` in clear text for the user's edit form. | same file | settings:write | nothing |
| credentials.listForSite | unmounted. S/credentials/CredentialAutofill.ts:255 | Lists test logins whose saved URL matches a tab URL (exact origin rules). Returns `{origin, items, unavailable}`. | `test-logins.bin`; setting `credentialAutofill.allowSubdomains` | preview:operate | nothing |
| credentials.fillForSite | unmounted. CredentialAutofill.ts:281 | The user picked a login in the browser key menu; fills 1-3 fields into the tab without a prompt. Source `vault` answers `provider_unavailable` for every field (:300). Checks the tab origin first. | `test-logins.bin`; no state kept | preview:operate | desktop client |
| secrets.answerRequest | S/ws.ts:2318 -> S/secrets/SecretRequests.ts:112 | The user answers a secret card: `save` (value), `decline`, or `reference` (read once from a secret provider, 1Password `op`). Stores the value under a one-use ref and records card status. Needs engine (card + run records); a `reference` answer also needs the outside secret provider. | Value: `<stateDir>/secrets/secret-request-<32hex>.bin`. Card status: orchestration events/projections (SQLite, `orchestration_v2_events`; exact turn-item table unconfirmed). | orchestration:operate | outside service |
| peerLinks.list | S/ws.ts:2661 -> S/peer/PeerLinks.ts:618 | Lists links with a live status: `reachable`, `unreachable` or `expired`. Probes each link's addresses (3 s). Renames a link to the peer's current label. | SQLite `peer_environment_links` (migrations 070, 071) | access:read | other Conn server |
| peerLinks.link | S/ws.ts:2663 -> PeerLinks.ts:497 | Links to a peer with a pairing code, using the peer's MCP OAuth (register, decide with `pairing-code`, token exchange, PKCE S256). Stores the token. | Row in `peer_environment_links`; token in `<stateDir>/secrets/peer-link-<32hex>.bin` | access:write | other Conn server |
| peerLinks.unlink | S/ws.ts:2664 -> PeerLinks.ts:636 | Deletes the row and the token file. Does not tell the peer. Returns `{removed}`. | same | access:write | nothing |
| peerLinks.answerRequest | S/ws.ts:2666 -> S/peer/PeerLinkRequests.ts:337 | Answers a link card from `conn_environment_link`: `link` (calls `PeerLinks.link`), `use-existing`, or `decline`. Records the outcome on the card and wakes the agent. Needs engine (card, notification) and the peer for `link`. | Card: orchestration events (turn item `link_request`). Link: as above. | access:write | other Conn server |
| guestShare.create | S/ws.ts:2314 -> S/guest/GuestShareService.ts:338 | Opens a guest share on a thread (dispatches `thread.guest-share.open`) and returns `https://<connect host>/guest#<id>.<sig>`. Needs the engine and the T3 Connect tunnel. | Share is in the thread projection (`thread.guestShare`, JSON in the thread payload). Signing key `<stateDir>/secrets/guest-share-signing-key.bin` (:71). Invite and session tokens are derived, not stored (:240-251). | access:write | outside service |
| projectClone.start | S/ws.ts:2845 -> S/project/ProjectCloneTracker.ts:281 | Prepares the clone, registers the project, runs `git clone` in the background. Returns `{projectId, cwd, remoteUrl, repository}` at once. With `provider`+`repository` it first looks the repo up through the provider CLI. | Memory only: `Ref<Map<ProjectId, TrackedClone>>`. The project itself goes through the project service (orchestration). | source-control:write | outside service |
| projectClone.cancel | S/ws.ts:2905 -> ProjectCloneTracker.ts:369 | Interrupts a running clone and deletes the partial checkout. Returns `{applied}`. | Memory | source-control:write | nothing |
| projectClone.retry | S/ws.ts:2907 -> ProjectCloneTracker.ts:388 | For a failed or cancelled clone: discards the partial folder and runs git again. Returns `{applied}`. | Memory | source-control:write | outside service |
| subscribeProjectClones (stream) | S/ws.ts:2909 -> ProjectCloneTracker.ts:436 | Sends the full list of clone snapshots on subscribe and after each change. | Memory (PubSub unbounded; stream buffer 1, sliding) | orchestration:read | nothing |
| agentSessions.scan | S/ws.ts:3019 -> S/project/AgentSessionScanner.ts:1821 | Scans Claude, Codex and Pi session files on disk and groups them into project candidates (path, title, thread count, last active). Last 30 days. | Reads provider homes; writes nothing. | orchestration:read | nothing |
| agentSessions.import | S/ws.ts:3020 -> S/project/AgentSessionImporter.ts:203 | Imports recent provider transcripts for one project as threads (writes domain events). Returns `{importedCount, skippedCount}`. | Orchestration events (`orchestration_v2_events`) and projections. Reads provider homes. | orchestration:operate | engine |

## MCP tools (18)

All MCP tools are declared with `McpToolAccess` (`S/mcp/McpToolAccess.ts`). Rule lines: `reads` 142, `readsAsCaller` 148, `actsAsCaller` 151, `writes` 166, `writesEnvironment` 327. `readsAsCaller` and `actsAsCaller` need a calling thread (`requireThreadCaller`, :138). `actsAsCaller` also runs `writingCaller` (:128): refuses a read-only MCP client with `capability_denied`, and checks the thread is live. `writesEnvironment` (:327) needs a full-access/default caller, refuses linked callers unless `linkedCallers: "allowed"`, and refuses read-only clients.

| Tool | T3 handler | What it does | State | Access rule | Needs |
| --- | --- | --- | --- | --- | --- |
| annotations_list | S/mcp/toolkits/annotations/handlers.ts:28 | Lists the caller thread's project annotations (todo and in progress; all with `all: true`). | annotation files | `readsAsCaller` | engine |
| annotations_claim | handlers.ts:37 | Claims the oldest todo that is not a question, or one by id. Sets `in_progress`, `claimedAt`. Adds `screenshotPath` (a local file path). Returns `{annotation: null}` when nothing waits. | annotation files | `actsAsCaller` | engine |
| annotations_complete | handlers.ts:50 | `in_progress` to `done` with a summary. Done already: returns it unchanged. | annotation files | `actsAsCaller` | engine |
| annotations_release | handlers.ts:56 | Back to `todo`. With `question: true` it needs a summary and marks the annotation a question (automatic claims skip it). | annotation files | `actsAsCaller` | engine |
| save_test_login | S/mcp/toolkits/credentials/handlers.ts:17 | Saves a test login with `createdBy: "agent"`. Needs MCP capability `preview`. | `test-logins.bin` | `actsAsCaller` | nothing |
| request_credentials | credentials/handlers.ts:10 | Lists saved test logins for a domain: id, title, urls, source, username. Never password or code. Needs capability `preview`. | `test-logins.bin` | `readsAsCaller` | nothing |
| fill_credential | credentials/handlers.ts:24 | Fills one field (username, password or otp) into a browser tab. Checks the tab origin. Returns a status token only. The tab is a server browser tab or a desktop tab through `PreviewAutomationBroker`. Capability `preview`. | `test-logins.bin` | `actsAsCaller` | desktop client |
| request_secret | S/mcp/toolkits/orchestrator/handlers.ts:139 -> S/mcp/OrchestratorMcpService.ts:2306 | Shows a secret card in the thread and waits (poll every 500 ms) for the user. Returns a one-use `secretRef`, or a file path (`delivery: "file"`). With `value` set: no card, writes the file at once. Needs engine (card) and a client to answer. | Card: orchestration events. Value: `secrets/secret-request-<32hex>.bin`; file: `secrets/files/<32hex>`. | `actsAsCaller` | desktop client |
| panel_open | S/mcp/toolkits/panels/handlers.ts:110 | Asks a connected desktop to show a panel: browser, database, mcp, diff, files. `browser` with `url` opens a tab first (server tab through the broker, or a desktop tab, then waits for the desktop to host it). | Memory (broker `pending`) | `actsAsCaller` | desktop client |
| database_query | panels/handlers.ts:54 | Runs a read-only SQL statement in the desktop Database panel; returns columns, row count, first 20 rows. | Memory | `actsAsCaller` | desktop client |
| mcp_connect | panels/handlers.ts:92 | Adds or updates an MCP server in the desktop MCP panel and connects. | Memory here; the desktop saves the server (headers and env are "saved in the panel") | `actsAsCaller` | desktop client |
| mcp_call | panels/handlers.ts:72 | Calls an MCP tool through the desktop MCP panel. | Memory | `actsAsCaller` | desktop client |
| conn_environment_read | S/mcp/toolkits/environment/handlers.ts:44 | Returns environment id, label, server version, platform and five preference fields. Cuts `customInstructions` to 4000 characters (`truncated` flag). | Server settings (settings file) | `reads` | nothing |
| conn_environment_preferences_update | environment/handlers.ts:57 | Patches the same five preference fields. Takes the thread's executor lock when a thread calls. | Server settings | `writesEnvironment` | engine |
| conn_environment_links | S/mcp/toolkits/orchestrator/handlers.ts:201 -> S/peer/PeerForwarding.ts (`links`) | Lists links and whether each answers now. Hidden when Linked environments is off. | `peer_environment_links` | `reads` | other Conn server |
| conn_environment_link | orchestrator/handlers.ts:210 -> S/peer/PeerLinkRequests.ts:174 | Shows a link card and returns `pending` at once. Returns `linked` when the named machine already has a usable link. The answer arrives later as a notification message. | Card: orchestration events | `writesEnvironment` | other Conn server |
| conn_environment_unlink | orchestrator/handlers.ts:217 | Forgets a link (row + token). Returns `{environmentId, removed}`. | `peer_environment_links`, token file | `writesEnvironment` | nothing |
| conn_project_clone | S/mcp/toolkits/project/handlers.ts:407 | Clones into a new or empty folder, no timeout, no tracker, no project registration (the agent calls `conn_project_create` after). Uses `SourceControlRepositoryService.cloneRepository` (S/sourceControl/SourceControlRepositoryService.ts:~340). | Disk only | `writesEnvironment` with `linkedCallers: "allowed"` | outside service |

Other tools in these areas: none found for guest share, agent sessions or secret providers. `conn_pending_request` (S/mcp/toolkits/thread/tools.ts:128) is about user-input questions, not secrets. `preview_*` tools call `CredentialAutofill.guardScript` (see credentials facts) and are out of scope.

## Counts (without scheduled tasks)

| Needs | RPC | MCP | Total |
| --- | --- | --- | --- |
| nothing | 13 | 4 | 17 |
| engine | 1 | 5 | 6 |
| desktop client | 3 | 6 | 9 |
| other Conn server | 3 | 2 | 5 |
| outside service | 4 | 1 | 5 |
| Total | 24 | 18 | 42 |

## Facts per area

### Annotations (files, mounted on T3)

- Id: `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$` (C/annotations.ts:12). Number: per project, `lastNumber + 1`, kept on edit. `revision` rises on every change in the project (`save`, AnnotationStore.ts:300).
- Statuses `todo`, `in_progress`, `done`. Claim needs `todo`; complete needs `in_progress` (done: no-op); release needs `in_progress` (todo: no-op). Wrong status: `AnnotationConflictError`, message "Annotation {id} is {status}; it must be {expected}. Read the list again." (C/annotations.ts:155).
- Other errors (tag: message): `AnnotationProjectNotFoundError` "This project is not on this server."; `AnnotationNotFoundError` "Annotation {id} is gone. The user may have removed it; do not recreate it."; `AnnotationRemovedError` "Annotation {id} was removed."; `AnnotationInvalidError` "An annotation needs a comment." / "The screenshot must be a base64 PNG, JPEG or WebP data URL." / "A question needs the question as summary."; `AnnotationStoreError` with reasons "Could not read the project.", "Could not read the annotations.", "Could not save the annotation.", "Could not save the screenshot.", "Could not remove the annotations.", "Could not read the screenshot.".
- Screenshot: regex `^data:image/(png|jpe?g|webp);base64,...` (AnnotationStore.ts:47). Stored as a file; the record keeps only `hasScreenshot`. No size cap found. Comment is trimmed and must not be empty.
- Writes: temp file `<file>.tmp` then rename (:147-154). No fsync. Removal writes `_deleted.json` first so a stopped removal finishes at next load (:417-423, 203-206). A removed id can never be created again (`AnnotationRemovedError`).
- Project directory name: project id with chars outside `[A-Za-z0-9._-]` replaced by `_` (:142). The project must exist (`requireProject`).
- No cap on items per project found. Loaded into memory per project on first use and never evicted (`entries` map, :138).
- Wire: subscribe sends `{annotations: [...]}` sorted by number; create answers `{annotation}`; remove answers `{removedIds}`. The MCP claim result adds a local `screenshotPath`.

### Panels (memory only; unmounted RPCs)

- Constants: default show timeout 15 000 ms (AgentPanelBroker.ts:19); `PANEL_ACTION_TIMEOUT_MS` 90 000 for `database_query`, `mcp_call`, `mcp_connect` (panels/handlers.ts:15); hosted tab wait 20 000 ms, poll 250 ms (:13, 16).
- Request id: `crypto.uuidV4()`; contract allows trimmed non-empty up to 128 characters (C/agentPanels.ts:16). `show` sends to every subscriber; with zero subscribers it fails at once. The pending table has one entry per call and is cleared when the call ends. No cap on subscribers or queue size (unbounded queue per subscriber).
- Panel kinds: `browser`, `database`, `mcp`, `diff`, `files` (C/agentPanels.ts:12). Limits: `sql` 64 000 characters, URL 8192, panel name 200, MCP header/env value 8192 (:17-21).
- Errors (`AgentPanelUnavailableError`, reasons seen): `no_desktop` "No Conn desktop app is connected to this server, so nothing can show the panel. Ask the user to open Conn on their Mac."; `timeout` "No Conn desktop showed the {panel} panel within {n} s."; `rejected` (desktop's own error, or "Conn could not show the {panel} panel."; "The Conn desktop showed the {panel} panel but sent no result. It may run an older Conn."); `invalid` (e.g. "Pass url or command, not both."); `tab_not_hosted`.
- Wire: stream item is `AgentPanelRequest` (`requestId, threadId, panel, tabId?, sql?, connection?, run?, mcpServer?, mcpCall?, focusWindow`). `panels.respond` carries `{requestId, ok, deviceName?, error?, database?, mcp?, mcpCall?}` and returns no payload.
- MCP headers and env for `mcp_connect` travel through the request and are "saved in the panel" on the desktop (C/agentPanels.ts:39-44). The server keeps nothing.
- FORK.md:~795 says panel actions fail with `NOT_ON_THREAD` when the user is on another thread; that code is desktop-side (unconfirmed in server code).

### Test logins, credentials, autofill

- **Stored:** one file, `<stateDir>/secrets/test-logins.bin` (`SECRET_NAME = "test-logins"`, TestLoginStore.ts:46; path rule `${name}.bin`, ServerSecretStore.ts:171; `secretsDir = stateDir/secrets`, S/config.ts:174). Content is UTF-8 JSON `{version: 1, logins: [{id, label, url, username, password, otpSecret|null, createdAt, createdBy: "user"|"agent"}]}` (:27-42). The whole file is rewritten on each change under one semaphore (:81, 101-112).
- **Protection:** plaintext. No encryption, no OS keychain. The `secrets` directory is chmod 0700 (ServerSecretStore.ts:161); the file is written to `<name>.bin.<uuid>.tmp`, chmod 0600, renamed, chmod 0600 (:199-205). `password` and `otpSecret` sit in the JSON in clear text.
- **Ids and limits:** id is `uuidV4` (TestLoginStore.ts:122). `CredentialItemId` accepts a 26-char `[a-z0-9]` legacy id or a UUID (C/credentials.ts:16-20). Text fields max 1024 characters (:210). `url`, `username` non-empty. `label`, `url`, `otpSecret` are trimmed; empty `otpSecret` becomes null (:128-132). No cap on the number of logins.
- **What an agent can read:** `request_credentials` returns `id, title (label or username), urls, source "test", username`. It never returns password or code (CredentialAutofill.ts:162-178). `fill_credential` returns only `{status, message}` with a fixed status token (C/credentials.ts:79-97; messages at CredentialAutofill.ts:47-60). `save_test_login` returns a summary (`hasOtp`, no secrets). **What an agent cannot read through tools:** password, otp secret, the current one-time code. Whether the agent's own shell can read `secrets/test-logins.bin` is unconfirmed (same OS user as the server is expected; no sandbox seen in this code).
- **What the user's client can read:** `testLogins.reveal` returns `{password, otpSecret}` in clear text to any client with `settings:write`.
- **Fill path:** the server reads the value, computes the TOTP code itself for `otp` (RFC 6238 in S/credentials/totp.ts: base32 secret or `otpauth://totp` URI; digits 6/7/8; period >0; sha1/sha256/sha512; default 6/30/sha1), and sends the clear value to the tab in a `credentialFill` broker operation (`CredentialFillRequest.value`, CredentialAutofill.ts:236-248). The page must be on the right origin; the tab side re-checks `expectedOrigin`. Server-side `Redacted` wraps the value in memory only. Test logins fill with no approval prompt. Vault logins never reach the server (desktop only); `credentials.fillForSite` with source `vault` returns `provider_unavailable` (:300).
- **Origin rules** (S/credentials/credentialOrigin.ts): same host ignoring `www.`, same port (default 443 for https, 80 for http), https unless the saved URL says http; a saved URL without scheme also allows http for `localhost`, `127.x.x.x`, `[::1]`, `*.localhost`, `*.test` (:9, 49). Subdomains only when `allowSubdomains` is on and the saved host has a registrable domain (uses `tldts` with private domains as public, :17-18). `request_credentials` matches by host only (:92-94); filling needs the exact origin.
- **Settings** (C/credentials.ts:144-155): `oneApprovalPerSignIn` false, `approvalTimeoutSeconds` one of 30/90/180 default 90 (Vault prompts only), `blockScriptsAfterFill` true, `allowSubdomains` false. With `blockScriptsAfterFill` the tab refuses agent JavaScript after a password or code fill (`PreviewAutomationCredentialLockError`; `guardScript` :349).
- **Errors:** `TestLoginNotFoundError` "No test login with this id."; `TestLoginStoreError` "Conn could not read or save its test logins."; fill statuses `filled`, `denied`, `tab_unavailable`, `origin_mismatch`, `field_not_found`, `not_editable`, `insert_failed`, `item_not_found`, `no_value`, `provider_unavailable` with the texts at CredentialAutofill.ts:47-60.
- `credentials.fillForSite` input: `fields` 1 to 3 entries; builds a fake thread scope `user:<threadId>` with capability `preview` (:285-296).

### Secrets (request_secret, secrets.answerRequest)

- **Stored:** the value goes to `<stateDir>/secrets/secret-request-<32hex>.bin` as JSON `{projectId, value, savedAt}` in clear text (SecretRequests.ts:40-42, 143-159). Same protection as test logins: dir 0700, file 0600 (`ServerSecretStore.create` uses `wx` open, fsync, chmod, hard link, ServerSecretStore.ts:236-256). The card (label, reason, url, placeholder, delivery, status) is in orchestration events; the value is never in events, projections or model context (SecretRequests.ts:1-4).
- **Ref:** `secret-ref:` + first 32 hex chars of HMAC-SHA256 over `${threadId}\0${turnItemId}`. The key is the hex text of 32 random bytes kept in `secrets/secret-request-salt.bin` (:33-35, 83-95). Pattern `^secret-ref:[0-9a-f]{32}$` (:35).
- **Limits:** ref TTL 24 h (`SECRET_REF_TTL_MS`, :36); expired refs are deleted when read; sweep at start and every hour (:384-390). Files in `secrets/files/` expire 24 h after mtime (:367-383). A ref is one-use: read, then delete; if the delete fails the value is not handed out (:259-270). The ref is tied to the project id. Only consumer of `consume` found: scheduled-task webhook signature (S/scheduledTasks/ScheduledTaskService.ts:1491).
- **`request_secret` input** (C/orchestratorMcp.ts:788-818): `label`, `reason` required; `url` http(s) only; `placeholder`; `delivery` `secretRef` (default) or `file`; `value` (pasted, non-empty, no max found); `timeoutMs` 1 000 to 3 600 000, default 600 000 (S/mcp/OrchestratorMcpService.ts:139, 142); `clientRequestId` up to 256 characters. Poll every 500 ms (:150). Needs an active run owned by the same MCP provider session, else `parent_not_active`: "Asking for a secret requires an active run owned by this MCP provider session." A pasted `value` with `delivery: "secretRef"` fails with `invalid_request`.
- **Card id:** `turn-item:secret-request:<urlencoded threadId>:<urlencoded key>` (OrchestratorMcpService.ts:2344). Closes as `cancelled` on timeout, abort or run end (:2368-2380).
- **Result union:** `{status:"saved", secretRef}`, `{status:"saved", file}`, or `{status: declined|cancelled|timed_out, note}` with notes from C/secretRequest.ts:31-38. File delivery: dir `secrets/files` 0700, file `<32hex>` 0600, `wx` partial then rename (SecretRequests.ts:272-286). The agent's shell is meant to read this file ("Read it inside commands and never print it. Deleted after 24 hours.", C/orchestratorMcp.ts:831-833). The agent never sees a `secretRef` value; it passes the ref to a tool.
- **Answer rules** (`secrets.answerRequest`): `answer.type` `save` (trimmed non-empty), `decline`, `reference {provider, reference}` (provider slug max 64 `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`; reference max 1024, one line; C/secretReference.ts:8-26). `reference` is accepted only by servers advertising `capabilities.secretRequestReferences` (C/server.ts:724). The provider is read fresh (`resolver.invalidate` first, SecretRequests.ts:101).
- **Secret provider:** only 1Password. It runs `op --cache=false read --account=<account> --no-newline <ref>`; for several references `op inject -i <temp template>` (S: `M/packages/secret-provider-onepassword/src/server/driver.ts:35, 60`). Timeout 45 s (`READ_TIMEOUT`, :15). A failed read returns undefined, shown as `reference_unreadable`. The resolver keeps results for the server's life (`M/packages/secret-provider-core/src/server/SecretResolver.ts:2-3`): a memory cache, no cap seen, cleared by `invalidate`.
- **Errors** (`SecretRequestError`, C/secretRequest.ts:40-56): `load_failed` "Could not load the secret request."; `not_found` "This secret request no longer exists."; `already_answered` "This secret request was already answered."; `agent_stopped` "The agent that asked has stopped, so this secret can't be used."; `store_failed` "Could not store the secret."; `reference_unreadable` "Could not read the secret from the secret provider." (with a provider name: `Could not read the secret from the secret provider "{name}". Unlock it and try again, or enter the value.`); `record_failed` "Saved the secret, but could not update the request."; `invalid_ref`, `read_failed`, `ref_unavailable`, `ref_expired`, `consume_failed`, `not_a_file_request` (texts at the same lines).
- A racing answer is safe: create-before-record, an `AlreadyExists` error is ignored, a failed record deletes the stored value (SecretRequests.ts:141-187). Command id `secret-request:<itemId>:<saved|declined>` makes the record idempotent.

### Peer links

- **Stored:** SQLite table `peer_environment_links` (`environment_id` PK, `secret_name`, `label`, `urls_json`, `access`, `linked_at`, `expires_at`, `last_reached_at`, `last_error`, `fenced`; migrations `S/persistence/Migrations/070_PeerLinks.ts`, `071_PeerLinkFence.ts`). The peer's session token (`access_token`) is in `<stateDir>/secrets/peer-link-<32hex>.bin`, plaintext, 0600 (PeerLinks.ts:247-249, 357-361).
- **Access levels** (`AuthMcpClientAccess`): `read-only`, `approval-required`, `auto-accept-edits`, `auto`, `full-access` (C/auth.ts:279-285).
- **Link flow** (PeerLinks.ts:497-): needs setting `linkedEnvironmentsEnabled` (default false, C/settings.ts:1659), else `PeerLinkError` reason `disabled`, "Linked environments is off on this machine. Turn it on in Settings → Labs." Probes the peer's descriptor (HTTP API `metadata.descriptor`); registers an OAuth client (redirect `http://127.0.0.1/t3code-peer-link`, `software_id` `MCP_PEER_LINK_SOFTWARE_ID`); PKCE `S256` with a 32-byte verifier; posts a `pairing-code` decision; exchanges the code; redirects are never followed (`redirect: "manual"`, :255). Expiry = `expires_in` from the token response. The peer must advertise `mcpModeLimitHeader` and `linkFence` capabilities.
- **Timeouts:** descriptor probe 3 s for loopback, else 10 s, one retry after 1 s (PeerLinks.ts:55-58); list probe 3 s per link (:58). Addresses are probed in parallel at link time and `peer.environmentId` must match `expectedEnvironmentId`.
- **Address rule:** http only for loopback, Tailscale hosts, or Orbit WireGuard `10.44.x.x` (Conn fork, PeerLinks.ts:158); everything else must be https. A loopback address of this machine is refused when a machine was picked ("{origin} is this machine, not {name}.").
- **Errors** (`PeerLinkError.reason`): `unreachable`, `not_a_t3_environment`, `incompatible`, `self` ("That address is this environment."), `pairing_rejected`, `expired`, `unknown_link`, `storage` ("Linked environments could not be read or saved here. The server log has details."), `disabled`, `peer_disabled`. `PeerLinkRequestError` reasons: `load_failed` "Could not load the link request.", `not_found` "This link request no longer exists.", `already_answered` "This link request was already answered.", `record_failed` "Could not update the link request." (C/peerLink.ts:109-114).
- **Cards:** a link card is a turn item `turn-item:link-request:<threadId>:<namespace>:<key>` (PeerLinkRequests.ts:394). The agent call returns at once with `pending`; the user's answer wakes the agent with a notification message (`message:link-request:<id>`). The pairing code is used once and never recorded. One answer per card at a time (`KeyedLock`). No cap on cards.
- **Unlink** does not tell the peer; the peer keeps the session until revoked there.
- The forwarding of other tools to a peer (`PeerForwarding`, `PeerMcpClient`, `RemoteDelegation`) is not in the tag list. It is the reason `environmentId` exists on many MCP tools; its size is 1 500+ lines (unconfirmed what to cover).

### Guest share

- **Constants** (C/guestShare.ts:18-28): TTL 24 h; message max 4 000 characters; name max 40; pending messages 3; resolved messages kept 20; files per message 4; file max 10 MiB; pending attachment bytes per share 20 MiB.
- **Create:** needs setting `guestSharingEnabled` (default false), else `GuestShareCreateError` reason `disabled`, "Guest links are off. Turn them on in Settings > Labs."; needs a running T3 Connect tunnel hostname, else `connect_unavailable`, "Guest links need a running T3 Connect tunnel."; `thread_unavailable` "This thread cannot be shared."; `read_failed` "Failed to read the shared thread."; `changed` "The guest link changed while it was being created."
- **Id and token:** share id = base64url of 16 random bytes (GuestShareService.ts:72, 346). Invite = `<shareId>.<sig>` where sig = first 16 bytes of HMAC-SHA256 key over `guest-invite:<shareId>`, base64url (:233-251). Key: 32 random bytes in `secrets/guest-share-signing-key.bin`. Nothing secret is stored per share; replacing the share in the thread revokes its tokens. URL: `https://<host>/guest#<credential>`.
- Creating a new share replaces the thread's old one (revocation by replacement; exact behaviour of `thread.guest-share.open` on an existing share is unconfirmed).
- Not RPC but part of the area: guest HTTP routes under `/api/guest` (S/guest/http.ts: redeem, submit, stream, session, render, item, history, command-output, attachment, media) and session cookie `t3_guest_<shareId>` (C/guestShare.ts:127). `guestShare.create` is in `authorizedUpstreamWsRpcTags.json` (first entry), so it is an upstream tag.

### Project clone

- **Constants:** done snapshots stay 30 s (`DONE_RETENTION`, ProjectCloneTracker.ts:70); stall mark after 20 s without git output (`STALL_AFTER`, :74); `detail` max 200 characters, `error` max 1000 (C/projectClone.ts:10-11), cut with an ellipsis. `sequence` is a process-wide counter (:101).
- **Snapshot:** `{projectId, remoteUrl (credentials redacted), destinationPath, repository|null, phase running|done|failed|cancelled, stage connecting|counting|receiving|resolving|checkout, percent 0-100|null, detail, stalled?, error, startedAt, endedAt, sequence}`.
- **Start:** `prepareClone` makes the parent folder, refuses a non-empty destination ("Destination path already exists and is not empty."; "Choose a destination path before cloning."; "Enter a repository path or clone URL before cloning."). One clone per project id and per destination: "A clone into this destination is already in progress." (tag `SourceControlRepositoryError`, operation `cloneRepository`). The project is created first with `createWorkspaceRootIfMissing: true` (ws.ts:2847-2866). If an old project owns that folder (`ProjectConflictError`) the claim moves to that project (:343-350). Thread commands for a project still cloning fail: "The repository is still being cloned." / "The repository was not cloned. Retry the clone first." (:496-502).
- **Git:** `git clone --progress -- <url> <dirname>` with cwd = parent, env `GIT_PROGRESS_DELAY=0`, `GIT_TERMINAL_PROMPT=0`, `LANGUAGE=C` (SourceControlRepositoryService.ts:79-85, 359-366). Output cap 256 KiB with line callbacks kept. Failure detail = last 4 non-progress stderr lines, credentials redacted. Default timeout 120 000 ms (`CLONE_TIMEOUT_MS`, :78); the tracker and `conn_project_clone` pass `timeoutMs: null`. SSH rejected -> falls back to an https URL (`httpsFallbackUrl`).
- **Cancel/discard:** `discardClone` deletes only when the folder is empty or holds `.git`; otherwise "Destination path contains files that are not from the clone." (:462-467). Cancel returns false unless the clone is running with a fiber. Retry works only from `failed` or `cancelled`.
- **Restart:** the tracker is memory only; a restart forgets clones, and the half-made project keeps its empty folder (comment :342-343).
- **Wire:** results `{applied: boolean}` for cancel and retry; start answers `{projectId, cwd, remoteUrl, repository}` (projectId may differ after a conflict move). The stream sends the full array each time.

### Agent sessions

- **Scan** reads provider homes: Claude `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`, Codex `<CODEX_HOME>/sessions` plus `session_index.jsonl` and `state_5.sqlite`, Pi sessions dir (AgentSessionScanner.ts:1380, 1474, 1347, 189, 1719-1760). Homes come from provider instance settings. Window: last 30 days (`RECENT_THREAD_WINDOW_MS`, :84).
- **Caps** (AgentSessionScanner.ts:53-106): 5 000 transcripts per source; 20 000 discovery and metadata operations per source; 64 MiB metadata bytes per source; 100 000 metadata records per source, 1 000 per transcript; metadata read 8 KiB, scan up to 1 MiB per transcript; Codex index 1 MiB, 100 000 project-root rows; Git file reads 2 s deadline, 1 MiB, 16 at once, retry blocked paths after 5 min, up to 1024 blocked paths. `truncated` is set on the result when a cap hits.
- **Import caps:** 100 transcripts, 4 GiB total, 4 GiB per transcript, 100 000 records, 32 MiB history, 200 messages kept per thread (:86-91). Native history read timeout 2 minutes (AgentSessionImporter.ts:85). Event ids start with `agent-session-import:v2` (:45), which makes re-import skip what exists.
- **Errors** (C/agentSessions.ts:57-91): `AgentSessionImportProjectNotFoundError` "Project '{id}' does not exist."; `AgentSessionImportProjectChangedError` "Project '{id}' changed directories. Scan for projects again before importing history."; `AgentSessionScanError` "Failed to scan agent sessions during {read-settings|read-projects}." Result: `{importedCount, skippedCount}`; scan: `{candidates, scannedAt, truncated?}`. Transcript files are read-only inputs and are Claude/Codex/Pi formats (Pi is out of scope for the Conn Server).

## Open items

- What a client gets for an unmounted tag on the T3 server (unconfirmed).
- Exact SQLite table for turn items (secret and link cards); the events table is `orchestration_v2_events`, projections are `orchestration_v2_projection_*`.
- Whether `thread.guest-share.open` replaces an existing share (unconfirmed).
- Peer forwarding (`S/peer/PeerForwarding.ts`, `PeerMcpClient.ts`, `RemoteDelegation.ts`) is outside the tag list and not mapped here.
