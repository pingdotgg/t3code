# What a Conn client does at connect

Read from the recordings in `sessions/` (web client, contract commit `828a9a4855`). Timings are
from one run; the order holds across runs. `node recorder/summarize.mjs <scenario>` prints any
of them as a timeline. Secrets are redacted; shapes are real.

## Short answer

1. HTTP: `GET /.well-known/t3/environment` and `GET /api/auth/session`. Pairing and remote add
   a token exchange (see Auth).
2. HTTP: `GET /api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1` with header
   `x-t3-orchestration-protocol: 2`. A reconnect adds `&resumeFrom=<seq>` and gets
   `{"resumable":true}` instead of a snapshot.
3. WebSocket upgrade on `/ws` (query below).
4. `subscribeServerConfig` alone. **The client sends nothing else until the first chunk
   (`{"version":1,"type":"snapshot","config":…}`) arrives.** In every recording the next
   requests leave within 1 ms of that chunk.
5. Then, in one burst: `subscribeServerLifecycle` (twice, in parallel), `orchestration.subscribeShell`,
   `subscribeDeviceState`, `subscribeProjectClones`, `assets.createUrl`, `subscribeVcsBranch`,
   `preview.reportProfiles`, `subscribeTerminalMetadata`.
6. About 100–400 ms later, once the UI knows the active project and thread: the rest of the list
   below, including `orchestration.subscribeThread` when a thread is open.

Must be real for the thread list, by inference from the order (no fault injection yet): the
environment descriptor, the auth session, the HTTP shell snapshot, the `/ws` upgrade,
`subscribeServerConfig` (gates everything), and `orchestration.subscribeShell`. Every other
method below is called at connect, but what the UI does when it fails is untested. Track (a)
should answer the rest with `ConnServerNotSupported` and watch the UI.

## `/ws` query

```
/ws?clientSurface=web&clientAppVersion=0.1.9&clientDeviceType=desktop&clientOs=macOS
   &clientWebDeployment=server&clientBrowser=Chrome&connectionMethod=direct
   &clientDevice=<64 hex chars>&orchestrationProtocol=2
   &clientCapabilities=settingsSecretReferences&frameParts=1
```

A remote environment puts `wsTicket=<ticket>` first. `frameParts=1` and
`orchestrationProtocol=2` are always present. The desktop app sends its own `clientSurface`,
`clientWebDeployment` and browser values (not recorded).

## Methods at connect

From `pairing` (socket 1, after the post-pairing reload) and `reconnect`. "Open" means the
stream never ends while the socket lives; the server sends no `Exit` for it.

| Method                                              | Kind   | First answer / notes                                                                                                                     |
| --------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribeServerConfig`                             | stream | `snapshot` (≈100–150 KB, sent in 2–3 frame parts), then `usageLimitSourcesUpdated`, `environmentThemesUpdated`, `providerStatuses`. Open |
| `subscribeServerLifecycle` ×2                       | stream | `welcome` with environment and sequence, then one more item. Open                                                                        |
| `orchestration.subscribeShell`                      | stream | `{"kind":"snapshot",…}` or nothing on resume, then `{"kind":"synchronized"}`, then `thread.updated` items. Open                          |
| `subscribeDeviceState`                              | stream | one state object. Open                                                                                                                   |
| `subscribeProjectClones`                            | stream | `[]`. Open                                                                                                                               |
| `subscribeTerminalMetadata`                         | stream | one item. Open                                                                                                                           |
| `subscribeVcsBranch {cwd}`                          | stream | one item. Open                                                                                                                           |
| `subscribeVcsStatus {cwd}`                          | stream | one or two items. The client `Interrupt`s it and subscribes again after each turn                                                        |
| `subscribePreviewEvents`                            | stream | no items at all. Open                                                                                                                    |
| `subscribeDiscoveredLocalServers`                   | stream | one item. Open (only with a thread open)                                                                                                 |
| `scheduledTasks.subscribe`                          | stream | one item. Open (only with a thread open)                                                                                                 |
| `annotations.subscribe {projectId}`                 | stream | one item. Open (fork method)                                                                                                             |
| `orchestration.subscribeThread`                     | stream | `snapshot`, `synchronized`, then `event` items. Open                                                                                     |
| `assets.createUrl {resource}`                       | unary  | `{relativeUrl:"/api/assets/<payload>.<sig>"}` (project favicon)                                                                          |
| `preview.reportProfiles`                            | unary  | `null`                                                                                                                                   |
| `preview.list {threadId}`                           | unary  |                                                                                                                                          |
| `projects.readFile {cwd,relativePath,allowMissing}` | unary  |                                                                                                                                          |
| `server.reportClientActivity`                       | unary  | `null`; repeats every few seconds                                                                                                        |
| `server.refreshProviders`                           | unary  | provider list; again with `{modelCatalogOnly:true}` when the model picker opens                                                          |
| `server.discoverSourceControl`                      | unary  | slow (≈1 s)                                                                                                                              |
| `orchestration.dispatchCommand`                     | unary  | `{type:"thread.visit",…,opened:true}` → `{sequence}`                                                                                     |
| `orchestration.getArchivedShellSnapshot`            | unary  |                                                                                                                                          |
| `orchestration.getOlderSettledThreads`              | unary  | `{before,limit}`, ≈700 ms after connect                                                                                                  |
| `vcs.listRefs`                                      | unary  | twice: `{cwd,limit}` and `{cwd,query,limit}`                                                                                             |
| `review.getDiffPreview`                             | unary  | twice, ≈1 s after connect                                                                                                                |

HTTP alongside: `POST /api/observability/v1/traces` (OTLP JSON, answer 204) about once a
second, and `GET /api/auth/session` again right after the socket opens.

## Opt-in flags

`subscribeServerConfig`, always:
`{"environmentThemes":true,"usageLimitSources":true,"usageLimitsCommand":true,"workspaceSnapshotsOnDemand":true}`

`orchestration.subscribeShell`:

- first connect: `{"afterSequence":<seq of the HTTP snapshot>,"knownProjectIdentities":"<hash>","requestCompletionMarker":true,"omitIdleSubagents":true,"omitOlderSettled":true}`
- reconnect: `{"afterSequence":<seq>,"httpSnapshotFallback":true,"requestCompletionMarker":true,"omitIdleSubagents":true,"omitOlderSettled":true}`

`orchestration.subscribeThread`, always:
`{"threadId":…,"requestCompletionMarker":true,"acceptBoundedSnapshot":true,"acceptDeferredWork":true,"acceptCompactTurnItems":true,"acceptDedupedBodies":true,"acceptCompactIds":true}`

So the client sends every opt-in unconditionally. The server decides what to honour from its
advertised capabilities.

`server.refreshProviders`: `{instanceId,cwd,workspaceSnapshotsOnDemand:true,usageLimitsCommand:true}`.

## Auth per step

Same-origin web (`pairing`, `reconnect`), server auth policy `loopback-browser`:

| Step | Call                             | Sends                                                | Gets                                                                                                                                             |
| ---- | -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `GET /pair`                      | token only in the URL fragment                       | HTML                                                                                                                                             |
| 2    | `GET /api/auth/session`          | no session cookie                                    | `{authenticated:false, auth:{policy, bootstrapMethods:["one-time-token"], sessionMethods:[…], sessionCookieName:"t3_session_<port>_<hash>", …}}` |
| 3    | `POST /api/auth/browser-session` | JSON `{"credential":"<pairing token>"}`, `Origin`    | `Set-Cookie: t3_session_…` (≈780 chars), body `{authenticated:true, scopes, permissions, …}`                                                     |
| 4    | everything after                 | the session cookie, on HTTP and on the `/ws` upgrade | —                                                                                                                                                |

The page then reloads `/`, so the socket opened right after pairing (socket 0) closes within
10 ms, before it sends a frame.

Remote environment (`remote`), the path Conn desktop takes to another machine:

| Step | Call                                  | Sends                                                                                                                                                                                                                                                                  | Gets                                                                                                                    |
| ---- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | `GET /.well-known/t3/environment`     | `Origin` (cross-origin, no credentials)                                                                                                                                                                                                                                | descriptor                                                                                                              |
| 2    | `POST /oauth/token`                   | form: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<pairing code>`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`, `requested_token_type=…`, `client_label=T3 Code Web`, `client_device_type`, `client_os` | `{access_token (≈680 chars), issued_token_type, token_type:"Bearer", expires_in:2591999, scope:"orchestration:read …"}` |
| 3    | `POST /api/auth/websocket-ticket/rpc` | `Authorization: Bearer <access_token>`                                                                                                                                                                                                                                 | `{ticket (208 chars), expiresAt (+≈5 min)}`                                                                             |
| 4    | `/ws?wsTicket=<ticket>&…`             | ticket in the query; no cookie, no header                                                                                                                                                                                                                              | —                                                                                                                       |
| 5    | `GET /api/auth/session`, later HTTP   | `Authorization: Bearer <access_token>`                                                                                                                                                                                                                                 | session with scopes                                                                                                     |

Each new socket gets a fresh ticket (step 3 again). The web client uses Bearer here, not DPoP;
DPoP is for the managed relay (T3 Connect).

## Per scenario

**`pairing`**: auth steps 1–4, reload, then the connect sequence above. The auto-bootstrapped
thread is open, so `subscribeThread` and the thread-level calls run too. 86 frames.

**`reconnect`**: no pairing; the HTTP shell uses `resumeFrom`; the shell stream resumes with
`afterSequence` and `httpSnapshotFallback`. 58 frames.

**`turn`**: after connect, opening the model picker calls `server.refreshProviders
{modelCatalogOnly:true}`. Sending creates the thread and the turn in **one call**:
`orchestration.launchThread {commandId, creationSource:"web", threadId, projectId, title,
generateTitle:true, modelSelection:{instanceId:"claudeAgent", model:"claude-haiku-5-5"},
runtimeMode, interactionMode:"default", workspaceStrategy:{type:"root",branch:"main"},
initialMessage:{messageId,text,attachments:[]}}`. It answers with `{threadId, projection}`.
There is no `thread.create` or turn-start `dispatchCommand`. The client then subscribes to the
thread (`subscribeThread`, `annotations.subscribe`, `thread.visit`). Thread events, in order:
`thread.metadata-updated`, `thread.visited`, `checkpoint-scope.created`, `node.updated`,
`turn-item.updated`, `run.updated`, `provider-session.attached`, `provider-session.updated`,
`provider-thread.updated`, `run-attempt.updated`, `provider-turn.updated`, `message.updated`,
`checkpoint.captured` ×2. The shell stream sends a `thread.updated` after most of these. The
short answer came as one `message.updated`, not as text deltas. 146 frames.

**`permission`**: as `turn`, with `runtimeMode:"approval-required"`. The prompt arrives as a
`runtime-request.updated` event. Approve is
`orchestration.dispatchCommand {type:"runtime-request.respond", commandId, threadId,
requestId:"runtime-request:provider:claudeAgent:…", decision:"accept"}`. 175 frames.

**`interrupt`**: after approving the `ping`, the stop button sends
`orchestration.dispatchCommand {type:"thread.stop", commandId, threadId}`, then
`orchestration.getTurnItem {threadId,itemId}`. It is a command, not an RPC `Interrupt` frame.
179 frames.

**`remote`**: remote auth steps 1–5, then the same connect sequence on the second server. A
page reload reconnects with a new ticket. 82 frames.

## Against the wire section of the workspace README

Nothing contradicts it. Details it does not state:

- **The `/ws` URL can carry `wsTicket`** (remote environments) in place of a cookie.
- **No client JSON arrays, no `discard`, no `isNotification`, no `Eof`.** The client closes the
  socket without `Eof` when the page goes away. Every request has `headers: []` and
  `traceId`/`spanId`/`sampled`.
- **Request ids are not per-socket from 0.** On the remote socket they started at 12 and
  skipped numbers. Echo them back; never assume a range.
- **`Interrupt` exits carry a number:** `{"_tag":"Interrupt","fiberId":3767}`, not `null`.
  The client sends `Interrupt` for `subscribeVcsStatus` when it resubscribes, and expects that
  exit back.
- **Frame parts are in use at connect:** the `subscribeServerConfig` snapshot always splits
  (2–3 parts here, because it lists the host's skills). A server with fewer skills may stay
  under 48 KiB.
- **`Ping` every 5 s, `Pong` back,** as stated.
- **No typed failures or defects occurred.** All 200 requests succeeded or ended with an
  `Interrupt` exit, so the recordings do not exercise `Fail`, `Die` or `Defect`.

## What the web recording cannot show about the desktop app

- **Main-process and preload calls.** The desktop app exposes `window.desktopBridge` (preload).
  Through it the client reads saved environments and their tokens from OS secure storage, gets
  the local backend's bootstrap token, and runs SSH, WSL and update flows. None of that crosses
  HTTP or `/ws`, so it is not here.
- **The desktop-local backend.** Desktop starts its own server with `--bootstrap-fd`, then the
  renderer exchanges that bootstrap token over `POST /oauth/token` for a Bearer session, as in
  `remote` (`loadSecondaryConnectionRegistration` in `apps/web/src/connection/platform.ts`).
  Not recorded.
- **Its `/ws` query values.** Expect a different `clientSurface` and `clientWebDeployment`, and
  maybe other `clientCapabilities`; the server must accept unknown values.
- **Desktop-only RPCs** a desktop window may call at start (for example browser or device
  features); the web client skips those it cannot use.
- **Orbit.** Conn desktop may reach an Orbit container through the Orbit panel's own pairing,
  not Settings › Connections. If so, the HTTP steps before `/ws` can differ from `remote`.
