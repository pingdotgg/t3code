# t3code WebSocket Wire Protocol Specification

> Target audience: an independent **native Swift macOS client** that speaks the
> t3code server's WebSocket RPC protocol directly, without the Effect-TS
> runtime.
>
> Every claim below cites `file:line` in this monorepo (or in the vendored
> `effect@4.0.0-beta.78` source under `node_modules/.pnpm/effect@4.0.0-beta.78…/node_modules/effect/src`,
> abbreviated **`effect/src`** below).
>
> **Version pin:** the transport is Effect's _unstable_ RPC
> (`effect/unstable/rpc`) at `effect@4.0.0-beta.78`
> (`node_modules/.pnpm/effect@4.0.0-beta.78_patch_hash=…`). The envelope shapes in
> §2 are an **unstable** API and can change between Effect betas. See §6.

---

## 1. Connection

### 1.1 Endpoint

- **Path:** `GET /ws`, upgraded to WebSocket.
  Registered server-side at `apps/server/src/ws.ts:1796-1798`
  (`HttpRouter.add("GET", "/ws", …)`).
- **Scheme/host/port:** the same HTTP server that exposes the API and the
  `/api/*` REST endpoints. Default listen port is **3773**
  (`apps/server/src/config.ts:17`, `DEFAULT_PORT = 3773`). Local desktop
  connections therefore use `ws://127.0.0.1:3773/ws`; remote/relay/SSH
  connections use `wss://<host>/ws`.
- **Client URL construction:** `packages/client-runtime/src/connection/resolver.ts:49-55`
  takes the target's `wsBaseUrl` and forces the path to `/ws` when empty
  (`primarySocketUrl`). The final URL string is stored on
  `PreparedConnection.socketUrl` (`packages/client-runtime/src/connection/model.ts:116-123`).
- The socket is opened with `Socket.layerWebSocket(connection.socketUrl, { openTimeout: "15 seconds" })`
  (`packages/client-runtime/src/rpc/session.ts:94-96`, `:23`). **No WebSocket
  subprotocol is negotiated** — `Socket.layerWebSocket` is called without a
  `protocols` argument (`effect/src/unstable/socket/Socket.ts:586,596,610`), so
  the browser/client sends no `Sec-WebSocket-Protocol` header.

### 1.2 Authentication / handshake

Authentication happens **at the HTTP upgrade**, before any RPC frame. The server
resolves the session in `EnvironmentAuth.authenticateWebSocketUpgrade`
(`apps/server/src/auth/EnvironmentAuth.ts:936-956`). Two mechanisms, tried in
this order:

1. **`wsTicket` query parameter (primary, browser-compatible).**
   `apps/server/src/auth/EnvironmentAuth.ts:501` defines the query key literal
   `wsTicket`; `:940-952` reads `url.searchParams.get("wsTicket")` and verifies
   it via `sessions.verifyWebSocketToken`. The final socket URL therefore looks
   like:

   ```
   wss://environment.example.test/ws?wsTicket=<opaque-ticket>
   ```

   (see fixtures `packages/client-runtime/src/connection/resolver.test.ts:124,138,236,284,341`).

   The ticket is a **short-lived, single-use-ish token** obtained _over HTTP
   before_ opening the socket:
   - `POST /api/auth/websocket-ticket` (`packages/contracts/src/environmentHttp.ts:373-377`),
     authenticated with `Authorization: Bearer <access-token>` (or DPoP), returns
     `AuthWebSocketTicketResult = { ticket: string, expiresAt: <ISO-8601 UTC string> }`
     (`packages/contracts/src/auth.ts:196-200`; server side
     `EnvironmentAuth.issueWebSocketTicket` `apps/server/src/auth/EnvironmentAuth.ts:918-929`).
   - The Swift client should: acquire an access token → `POST` the ticket
     endpoint → append `?wsTicket=<ticket>` → open the socket. Re-issue a fresh
     ticket on every (re)connect.

2. **HTTP header / cookie fallback.** If no `wsTicket` is present, the server
   falls back to `authenticateRequest` (`apps/server/src/auth/EnvironmentAuth.ts:955`),
   which accepts (in precedence order, `:594-597`):
   - session **cookie** (`request.cookies[sessions.cookieName]`),
   - `Authorization: Bearer <token>` (`:499`, `:538-545`),
   - `Authorization: DPoP <token>` (`:500`, `:547-554`).

   A native Swift client using `URLSessionWebSocketTask` **can** set request
   headers, so `Authorization: Bearer …` on the upgrade request is a valid
   alternative to the query ticket. (Browsers cannot set WS headers, which is why
   the ticket exists.)

On success the server binds the authenticated session to the socket, marks the
session connected for its lifetime (`apps/server/src/ws.ts:1842-1846`), and
serves RPCs. On failure the upgrade returns an HTTP error response
(`apps/server/src/ws.ts:1848-1852`; `EnvironmentAuthInvalidError` → 401-class).

**Per-RPC authorization (scopes).** Even after the socket authenticates, every
RPC method is gated by a required scope, enforced inside each handler
(`apps/server/src/ws.ts:277-346`, `RPC_REQUIRED_SCOPE`). A call whose session
lacks the scope fails with `EnvironmentAuthorizationError`
(`{ _tag:"EnvironmentAuthorizationError", message:string, requiredScope:string }`,
`apps/server/src/ws.ts:437-441`; schema `packages/contracts/src/auth.ts:286`) — it
does **not** close the socket. `requiredScope` is one of the literal wire values
`"orchestration:read" | "orchestration:operate" | "terminal:operate" |
"review:write" | "access:read" | "access:write" | "relay:read" | "relay:write"`.
The method→scope assignment map is `apps/server/src/ws.ts:277-346`.

### 1.3 There is no initial application handshake frame

After the socket opens, neither side sends a mandatory protocol "hello". The
client's first frame is simply the first RPC it chooses to issue. The reference
client immediately calls `server.getConfig` for initial sync
(`packages/client-runtime/src/rpc/session.ts:116-126`), and treats the connection
as `ready` once the socket `onConnect` hook fires **and** that first
`server.getConfig` resolves (`:131-136`). A Swift client may issue any RPC first.

### 1.4 Heartbeat / ping (application-level, inside WebSocket frames)

The RPC layer runs its **own** liveness ping _as JSON frames_ — this is separate
from (and in addition to) any RFC 6455 control-frame ping/pong the WebSocket
library does.

- The client sends `{"_tag":"Ping"}` every **5 seconds**
  (`effect/src/unstable/rpc/RpcClient.ts:1043,1161-1183`; `makePinger` uses
  `Effect.delay("5 seconds")`).
- The server replies with `{"_tag":"Pong"}`
  (`effect/src/unstable/rpc/RpcServer.ts:759-760`, `constPong`).
- The client tracks whether the previous ping was ponged; if a ping goes
  unanswered by the next 5 s tick, the pinger opens a timeout latch that races the
  socket read loop and fails it as a "ping timeout" `SocketError`
  (`RpcClient.ts:1093-1106,1161-1183`). Net effect: **~5–10 s** without a `Pong`
  is treated as a dead connection.

A Swift client should: (a) send `{"_tag":"Ping"}` every 5 s and expect
`{"_tag":"Pong"}`; and (b) reply to any inbound `{"_tag":"Ping"}` with
`{"_tag":"Pong"}` (the server only ever _answers_ pings, but implementing the
responder is cheap and future-proof).

### 1.5 Reconnect behavior

The socket-level protocol is created with `retryTransientErrors: false` and
`retryPolicy: Schedule.recurs(0)` (`packages/client-runtime/src/rpc/session.ts:99-102`),
i.e. the Effect RPC socket does **not** auto-reconnect. Reconnection is driven a
layer up by the connection _supervisor_
(`packages/client-runtime/src/connection/supervisor.ts`), which tears down the
session and establishes a brand-new socket (new ticket, new `server.getConfig`,
new stream subscriptions). See §4.3.

---

## 2. Framing (the exact on-the-wire envelope)

### 2.1 Serialization = plain JSON, one message per WebSocket frame

- The server provides `RpcSerialization.layerJson`
  (`apps/server/src/ws.ts:1816`); the client provides the same
  (`packages/client-runtime/src/rpc/session.ts:108`).
- `json` serialization has **`includesFraming: false`**
  (`effect/src/unstable/rpc/RpcSerialization.ts:84-97`). It does **not** use
  NDJSON, JSON-RPC, or MessagePack. The framing is provided by the **WebSocket
  message boundaries themselves**:
  - **Encode:** `JSON.stringify(message)` → the string payload of one WS text
    frame (`RpcSerialization.ts:94`).
  - **Decode:** `JSON.parse(frameText)`; if the parsed value is an array it is
    treated as a batch of messages, otherwise as a single message
    (`RpcSerialization.ts:90-93`).
- Server write path confirms one encoded message per frame for the unframed
  (JSON) case: `effect/src/unstable/rpc/RpcServer.ts:1051-1057` (`write:
!includesFraming ? (response) => offer(parser.encode(response))`), where each
  `offer` is one WS frame.

**Swift takeaway:** every inbound WS text frame is a complete JSON value. Parse
it; if it's a JSON **array**, iterate it as multiple messages; otherwise handle
it as one message object. When sending, put exactly one JSON object per WS text
frame (`JSON.stringify` equivalent). Frames are UTF-8 **text** frames.

### 2.2 Message vocabulary

All envelopes are defined in `effect/src/unstable/rpc/RpcMessage.ts`. Each object
is discriminated by a `_tag` string. Below, "encoded" = the on-the-wire form.

#### Client → Server (`FromClientEncoded`, `RpcMessage.ts:60`)

**`Request`** — invoke an RPC (`RpcMessage.ts:87-96`):

```jsonc
{
  "_tag": "Request",
  "id": "0", // stringified, monotonically increasing integer
  "tag": "server.getConfig", // RPC method name (see §3)
  "payload": {
    /* encoded payload */
  },
  "headers": [], // array of [key, value] string pairs; usually []
  "traceId": "…", // optional (OpenTelemetry); omit if not tracing
  "spanId": "…", // optional
  "sampled": true, // optional
}
```

- `id` generation: a process-global counter starting at `0`, stringified
  (`RpcClient.ts:233` `requestIdCounter = BigInt(0)`, `:288`, and `:710`
  `id: String(message.id)`). A Swift client just needs a **unique string per
  in-flight request**; a monotonically increasing integer-as-string is simplest
  and matches the server's `Number(id)` expectations nowhere-critical (the server
  treats ids as opaque strings for JSON serialization).
- `headers` is an **array of `[string, string]` tuples**, not a JSON object
  (`RpcClient.ts:712` `Object.entries(message.headers)`). Empty `[]` is normal.
- `payload` is the RPC's payload **already schema-encoded** (dates as strings,
  etc. — see §5).

**`Ack`** — acknowledge one streamed chunk, enabling the next
(`RpcMessage.ts:146-149`):

```json
{ "_tag": "Ack", "requestId": "7" }
```

**`Interrupt`** — cancel an in-flight request / stream (`RpcMessage.ts:157-160`):

```json
{ "_tag": "Interrupt", "requestId": "7" }
```

**`Ping`** — liveness (`RpcMessage.ts:180-182`): `{ "_tag": "Ping" }`

**`Eof`** — client is done sending (`RpcMessage.ts:169-171`): `{ "_tag": "Eof" }`
(rarely needed for a socket client; the reference client never sends it,
`RpcClient.ts:734-736`).

#### Server → Client (`FromServerEncoded`, `RpcMessage.ts:218`)

**`Chunk`** — one batch of stream values for a streaming RPC
(`RpcMessage.ts:256-260`):

```jsonc
{
  "_tag": "Chunk",
  "requestId": "7",
  "values": [
    /* one or more encoded success-chunk values */
  ],
}
```

`values` is a **non-empty array**; the server may batch several stream emissions
into one `Chunk`. After processing a `Chunk`, the client **must** send an `Ack`
for that `requestId` (see §2.3).

**`Exit`** — terminal result of a request (`RpcMessage.ts:283-313`). Success:

```json
{
  "_tag": "Exit",
  "requestId": "0",
  "exit": {
    "_tag": "Success",
    "value": {
      /* encoded success */
    }
  }
}
```

Failure (a `Cause` = array of failure nodes):

```jsonc
{
  "_tag": "Exit",
  "requestId": "0",
  "exit": {
    "_tag": "Failure",
    "cause": [
      { "_tag": "Fail", "error": { "_tag": "SomeTaggedError" /* fields */ } },
      // …or { "_tag": "Die", "defect": <json> }
      // …or { "_tag": "Interrupt", "fiberId": 12 }   // fiberId may be undefined/absent
    ],
  },
}
```

- Expected/typed RPC errors (the RPC's declared `error` schema, §3) arrive as
  `{"_tag":"Fail","error":{…}}`. The `error` object is itself a tagged struct with
  its own `_tag` (e.g. `EnvironmentAuthorizationError`, `GitCommandError`).
- Unexpected server-side crashes arrive as `{"_tag":"Die","defect":…}` where
  `defect` is a serialized `Schema.Defect` (see §5.6).
- A streaming RPC ends with an `Exit`: `Success` (with `value` typically the
  stream's completion value — for pure streams the terminal value is the stream
  end) terminates the stream normally; `Failure` terminates it with the error.
  For a **streaming** RPC the data arrives as `Chunk`s and the stream is closed by
  the terminal `Exit` (`RpcServer.ts:565-586`; client side `RpcClient.ts:743-764`).

**`Defect`** — connection-level defect not tied to one request
(`RpcMessage.ts:348-351`): `{ "_tag": "Defect", "defect": <json> }`. Clears/kills
all in-flight requests (`RpcClient.ts:614-616`).

**`Pong`** — liveness reply (`RpcMessage.ts:418-420`): `{ "_tag": "Pong" }`.

**`ClientEnd`** — server signals the client connection ended
(`RpcMessage.ts:407-410`); the reference client ignores it
(`RpcClient.ts:617-619`). (Note `ClientEnd` carries a numeric `clientId` in the
decoded form; over the socket it is not normally emitted to a single-client
browser session.)

### 2.3 Streaming, acknowledgement & backpressure (critical)

Streaming RPCs use **mandatory per-chunk acknowledgement backpressure**:

- The server, after writing a `Chunk`, **blocks** on a latch until it receives an
  `Ack` for that `requestId` before sending the next chunk
  (`effect/src/unstable/rpc/RpcServer.ts:428-448`, `latch.closeUnsafe()` then
  `latch.await`; `:222-224` opens the latch on `Ack`).
- Acks are **enabled** for this server: `RpcServer.toHttpEffectWebsocket(WsRpcGroup, { disableTracing: true })`
  (`apps/server/src/ws.ts:1811-1813`) does not set `disableClientAcks`, and the
  default is `supportsAck = true` (`RpcServer.ts:146`).
- The socket client protocol reports `supportsAck: true`
  (`RpcClient.ts:1152`) and auto-sends an `Ack` after buffering each `Chunk`
  (`RpcClient.ts:588-596`).

**Swift takeaway (do not skip):** after handling every `Chunk`, send
`{"_tag":"Ack","requestId":"<same id>"}`. If you don't, the stream **stalls after
the first chunk** (or after the server's internal buffer fills).

### 2.4 Cancellation / interruption

To cancel an in-flight request or unsubscribe from a stream, send
`{"_tag":"Interrupt","requestId":"<id>"}` (`RpcClient.ts:725-732`). The server
interrupts the corresponding fiber (`RpcServer.ts:226-235`). Closing the
WebSocket also tears down all of that connection's server-side subscriptions.

---

## 3. RPC catalog

The RPC group is `WsRpcGroup` (`packages/contracts/src/rpc.ts:684-753`), built
from `Rpc.make(<method-name>, { payload, success, error, stream? })` declarations.
Method-name string constants live in `WS_METHODS`
(`packages/contracts/src/rpc.ts:147-235`) and `ORCHESTRATION_WS_METHODS`
(`packages/contracts/src/orchestration.ts:25-33`). The **`tag`** field of a
`Request` (§2.2) is exactly the string value listed here (e.g. `"projects.readFile"`,
`"orchestration.dispatchCommand"`, `"subscribeVcsStatus"`).

Conventions for the tables:

- **stream** = `true` means responses arrive as `Chunk`s (§2.3), terminated by an
  `Exit`; `false` means a single `Exit`.
- Every method's declared `error` is a `Schema.Union` that **always** includes
  `EnvironmentAuthorizationError` (`apps/server/src/ws.ts:437-441`), plus the
  domain errors noted. Omitted below for brevity except where domain-specific.
- Payload/success are named schemas; the file where each is defined is cited so
  the Swift `Codable` types can be generated 1:1.

### 3.0 Server-side handler wiring (for reference)

All handlers are registered by `makeWsRpcLayer` via `WsRpcGroup.of({ … })`
(`apps/server/src/ws.ts:944-1789`) and served over the socket by
`RpcServer.toHttpEffectWebsocket(WsRpcGroup, …)` (`apps/server/src/ws.ts:1811`).

### 3.1 Orchestration — threads, turns, projects, checkpoints (the core)

Defined in `packages/contracts/src/rpc.ts:593-647` and
`packages/contracts/src/orchestration.ts`.

| tag                                      | payload                                                                                                          | success                                                                                                                  | stream  | notes                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `orchestration.dispatchCommand`          | `ClientOrchestrationCommand` (union, `orchestration.ts:681-699`)                                                 | `DispatchResult` = `{ sequence: int }` (`orchestration.ts:1186-1189`)                                                    | no      | The single write path for projects/threads/turns. Error `OrchestrationDispatchCommandError` (`orchestration.ts:1260`). |
| `orchestration.getTurnDiff`              | `{ fromTurnCount:int, toTurnCount:int, threadId:string, ignoreWhitespace?:bool }` (`orchestration.ts:1191-1198`) | `ThreadTurnDiff` = `{ fromTurnCount:int, toTurnCount:int, threadId:string, diff:string }` (`orchestration.ts:1144-1150`) | no      | Error `OrchestrationGetTurnDiffError`.                                                                                 |
| `orchestration.getFullThreadDiff`        | `{ threadId:string, toTurnCount:int, ignoreWhitespace?:bool }` (`orchestration.ts:1203-1208`)                    | `ThreadTurnDiff`                                                                                                         | no      |                                                                                                                        |
| `orchestration.replayEvents`             | `{ fromSequenceExclusive:int }` (`orchestration.ts:1213-1216`)                                                   | `OrchestrationEvent[]` (`orchestration.ts:1218`)                                                                         | no      | Catch-up: fetch all events after a sequence.                                                                           |
| `orchestration.getArchivedShellSnapshot` | `{}`                                                                                                             | `OrchestrationShellSnapshot` (`orchestration.ts:413-419`)                                                                | no      |                                                                                                                        |
| `orchestration.subscribeShell`           | `{}`                                                                                                             | `OrchestrationShellStreamItem` (`orchestration.ts:445-452`)                                                              | **yes** | First item `{kind:"snapshot", snapshot}`, then live `project-*`/`thread-*` deltas.                                     |
| `orchestration.subscribeThread`          | `{ threadId:string }` (`orchestration.ts:454-457`)                                                               | `OrchestrationThreadStreamItem` (`orchestration.ts:1115-1124`)                                                           | **yes** | First item `{kind:"snapshot", snapshot:{snapshotSequence,thread}}`, then `{kind:"event", event}`.                      |

#### 3.1.1 `dispatchCommand` — the command union (client → server writes)

`ClientOrchestrationCommand` (`orchestration.ts:681-699`) is a **union
discriminated by the `type` string field**. Client-dispatchable members:

| `type`                        | key fields (all also carry `commandId:string`)                                                                                                                                                                                 | def                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `project.create`              | `projectId, title, workspaceRoot, createWorkspaceRootIfMissing?, defaultModelSelection?:ModelSelection\|null, createdAt`                                                                                                       | `orchestration.ts:465-474`                               |
| `project.meta.update`         | `projectId, title?, workspaceRoot?, defaultModelSelection?, scripts?`                                                                                                                                                          | `:476-484`                                               |
| `project.delete`              | `projectId, force?`                                                                                                                                                                                                            | `:486-491`                                               |
| `thread.create`               | `threadId, projectId, title, modelSelection, runtimeMode, interactionMode(dflt "default"), branch:string\|null, worktreePath:string\|null, createdAt`                                                                          | `:493-507`                                               |
| `thread.delete`               | `threadId`                                                                                                                                                                                                                     | `:509-513`                                               |
| `thread.archive`              | `threadId`                                                                                                                                                                                                                     | `:515-519`                                               |
| `thread.unarchive`            | `threadId`                                                                                                                                                                                                                     | `:521-525`                                               |
| `thread.meta.update`          | `threadId, title?, modelSelection?, branch?, worktreePath?`                                                                                                                                                                    | `:527-535`                                               |
| `thread.runtime-mode.set`     | `threadId, runtimeMode, createdAt`                                                                                                                                                                                             | `:537-543`                                               |
| `thread.interaction-mode.set` | `threadId, interactionMode, createdAt`                                                                                                                                                                                         | `:545-551`                                               |
| `thread.turn.start`           | `threadId, message:{messageId,role:"user",text,attachments:UploadChatAttachment[]}, modelSelection?, titleSeed?, runtimeMode(dflt "full-access"), interactionMode(dflt "default"), bootstrap?, sourceProposedPlan?, createdAt` | client variant `ClientThreadTurnStartCommand` `:600-617` |
| `thread.turn.interrupt`       | `threadId, turnId?, createdAt`                                                                                                                                                                                                 | `:619-625`                                               |
| `thread.approval.respond`     | `threadId, requestId, decision:ProviderApprovalDecision, createdAt`                                                                                                                                                            | `:627-634`                                               |
| `thread.user-input.respond`   | `threadId, requestId, answers:ProviderUserInputAnswers, createdAt`                                                                                                                                                             | `:636-643`                                               |
| `thread.checkpoint.revert`    | `threadId, turnCount:int, createdAt`                                                                                                                                                                                           | `:645-651`                                               |
| `thread.session.stop`         | `threadId, createdAt`                                                                                                                                                                                                          | `:653-658`                                               |

`ClientThreadTurnStartCommand` (`:600-617`) uses `attachments: UploadChatAttachment[]`
(client upload form); the internal `ThreadTurnStartCommand` (`:579-598`) uses
resolved `ChatAttachment[]`. `bootstrap` (`ThreadTurnStartBootstrap`, `:571-575`)
optionally atomically **creates the thread** (`createThread`, `:553-562`),
**prepares a git worktree** (`prepareWorktree`, `:564-569`), and/or **runs the
project setup script** (`runSetupScript`) as part of the first turn — handled
server-side at `apps/server/src/ws.ts:678-882`.

Supporting enums/objects:

- `ModelSelection` (`orchestration.ts:81-115`): wire object `{ instanceId:string,
model:string, options?:ProviderOptionSelections }`. Has a **decode transform**
  that promotes a legacy `{ provider, model }` shape to `{ instanceId, model }`
  (`:85-102`) — a fresh Swift client should always emit `instanceId`.
- `RuntimeMode` (`:117-122`): `"approval-required" | "auto-accept-edits" | "full-access"` (default `"full-access"`).
- `ProviderInteractionMode` (`:124-125`): `"default" | "plan"`.
- `ProviderApprovalDecision`, `ProviderUserInputAnswers`, `ProviderApprovalPolicy`
  (`:35-41`), `ProviderSandboxMode` (`:42-47`) — see `orchestration.ts` / `model.ts`.

#### 3.1.2 Thread/shell projection payloads (read models)

- `OrchestrationThread` (full thread detail, `orchestration.ts:344-368`):
  `id, projectId, title, modelSelection, runtimeMode, interactionMode, branch|null,
worktreePath|null, latestTurn|null, createdAt, updatedAt, archivedAt|null,
deletedAt|null, messages:OrchestrationMessage[], proposedPlans[], activities:
OrchestrationThreadActivity[], checkpoints:OrchestrationCheckpointSummary[],
session:OrchestrationSession|null`.
- `OrchestrationThreadShell` (list-row summary, `:390-411`): like the above minus
  messages/checkpoints, plus `latestUserMessageAt|null, hasPendingApprovals:bool,
hasPendingUserInput:bool, hasActionableProposedPlan:bool`.
- `OrchestrationProjectShell` (`:378-388`), `OrchestrationShellSnapshot`
  (`:413-419`: `{ snapshotSequence:int, projects[], threads[], updatedAt }`).
- `OrchestrationSession` (`:271-281`), `OrchestrationLatestTurn` (`:333-342`),
  `OrchestrationThreadActivity` (`:313-323`: `{ id, tone, kind, summary,
payload:unknown, turnId|null, sequence?, createdAt }`),
  `OrchestrationCheckpointSummary`/`File` (`:283-303`).

#### 3.1.3 The event envelope (`OrchestrationEvent`)

`OrchestrationEvent` (`orchestration.ts:1001-1113`) is a union **discriminated by
`type`** (23 members, listed in `OrchestrationEventType` `:783-807`). Every member
shares `EventBaseFields` (`:989-999`):

```jsonc
{
  "sequence": 42,                    // NonNegativeInt — global ordering key
  "eventId": "…",
  "aggregateKind": "thread",         // "project" | "thread"
  "aggregateId": "<projectId|threadId>",
  "occurredAt": "2026-07-04T12:00:00.000Z",   // ISO string
  "commandId": "…"     | null,
  "causationEventId": "…" | null,
  "correlationId": "…" | null,
  "metadata": { "providerTurnId"?, "providerItemId"?, "adapterKey"?, "requestId"?, "ingestedAt"? },
  "type": "thread.message-sent",
  "payload": { /* type-specific, e.g. ThreadMessageSentPayload :893-903 */ }
}
```

Event `type` values and payload defs: `project.created`(`:813`),
`project.meta-updated`(`:824`), `project.deleted`(`:834`), `thread.created`(`:839`),
`thread.deleted`(`:854`), `thread.archived`(`:859`), `thread.unarchived`(`:865`),
`thread.meta-updated`(`:870`), `thread.runtime-mode-set`(`:879`),
`thread.interaction-mode-set`(`:885`), `thread.message-sent`(`:893`),
`thread.turn-start-requested`(`:905`), `thread.turn-interrupt-requested`(`:918`),
`thread.approval-response-requested`(`:924`), `thread.user-input-response-requested`(`:931`),
`thread.checkpoint-revert-requested`(`:938`), `thread.reverted`(`:944`),
`thread.session-stop-requested`(`:949`), `thread.session-set`(`:954`),
`thread.proposed-plan-upserted`(`:959`), `thread.turn-diff-completed`(`:964`),
`thread.activity-appended`(`:975`).

Note `subscribeThread` only forwards a **subset** of live events
(`message-sent, proposed-plan-upserted, activity-appended, turn-diff-completed,
reverted, session-set` — `apps/server/src/ws.ts:253-273,1146-1157`); the rest are
reflected through `subscribeShell`/snapshot updates.

### 3.2 Server meta / config / settings

`packages/contracts/src/rpc.ts:237-318`. Errors include `KeybindingsConfigError`,
`ServerSettingsError`, `ServerProviderUpdateError`, plus `EnvironmentAuthorizationError`.

| tag                                | payload                                             | success                                                               | stream |
| ---------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- | ------ |
| `server.getConfig`                 | `{}`                                                | `ServerConfig` (`server.ts:409-421`)                                  | no     |
| `server.refreshProviders`          | `{ instanceId?:string }`                            | `ServerProviderUpdatedPayload` (`server.ts`)                          | no     |
| `server.updateProvider`            | `ServerProviderUpdateInput`                         | `ServerProviderUpdatedPayload`                                        | no     |
| `server.upsertKeybinding`          | `ServerUpsertKeybindingInput` (`server.ts:429-435`) | `ServerUpsertKeybindingResult` = `{keybindings, issues}` (`:440-444`) | no     |
| `server.removeKeybinding`          | `ServerRemoveKeybindingInput` (`:437-438`)          | `ServerRemoveKeybindingResult`                                        | no     |
| `server.getSettings`               | `{}`                                                | `ServerSettings` (`settings.ts`)                                      | no     |
| `server.updateSettings`            | `{ patch: ServerSettingsPatch }`                    | `ServerSettings`                                                      | no     |
| `server.discoverSourceControl`     | `{}`                                                | `SourceControlDiscoveryResult` (`sourceControl.ts`)                   | no     |
| `server.getTraceDiagnostics`       | `{}`                                                | `ServerTraceDiagnosticsResult`                                        | no     |
| `server.getProcessDiagnostics`     | `{}`                                                | `ServerProcessDiagnosticsResult`                                      | no     |
| `server.getProcessResourceHistory` | `ServerProcessResourceHistoryInput`                 | `ServerProcessResourceHistoryResult`                                  | no     |
| `server.signalProcess`             | `ServerSignalProcessInput`                          | `ServerSignalProcessResult`                                           | no     |

`ServerConfig` (`server.ts:409-421`) — the initial-sync object — is:
`{ environment:ExecutionEnvironmentDescriptor, auth:ServerAuthDescriptor, cwd,
keybindingsConfigPath, keybindings:ResolvedKeybindingsConfig,
issues:ServerConfigIssues, providers:ServerProviders,
availableEditors:EditorId[], observability:ServerObservability,
settings:ServerSettings }`. Each `ServerProvider` (`server.ts:156`) carries
`{ instanceId, driver, displayName?, enabled, installed, version:string|null,
status:"ready"|"warning"|"error"|"disabled", auth:{status,…}, checkedAt:ISO,
models:[], slashCommands:[], skills:[], … }`. `ServerConfigIssue`
(`server.ts:35`) is a union discriminated by **`kind`**
(`"keybindings.malformed-config" | "keybindings.invalid-entry"`).

`ServerSettings` (`settings.ts:366`) — every field has a decoding default so the
key may be absent on request but is always present on response:
`{ enableAssistantStreaming:bool, enableProviderUpdateChecks:bool,
automaticGitFetchInterval:number(ms), defaultThreadEnvMode:"local"|"worktree",
newWorktreesStartFromOrigin:bool, addProjectBaseDirectory:string,
textGenerationModelSelection:ModelSelection,
providers:{codex,claudeAgent,grok,opencode}, providerInstances:record,
observability:{otlpTracesUrl,otlpMetricsUrl} }`. `ServerSettingsPatch`
(`settings.ts:504`) is the same tree with **every field `optionalKey`** (send only
what changes). `ServerProviderUpdateInput` (`server.ts:554`) =
`{ provider:string, instanceId? }`.

`ServerLifecycleStreamEvent` (`server.ts:543`) is a union discriminated by
**`type`** with `version:1` + `sequence:number`: `welcome`
(`payload:{environment,cwd,projectName,bootstrapProjectId?,bootstrapThreadId?}`) and
`ready` (`payload:{at:ISO,environment}`).

### 3.3 Cloud / relay

`rpc.ts:320-331`.

| tag                          | payload | success                                                       | stream             |
| ---------------------------- | ------- | ------------------------------------------------------------- | ------------------ |
| `cloud.getRelayClientStatus` | `{}`    | `RelayClientStatusSchema` (`relayClient.ts:3`)                | no                 |
| `cloud.installRelayClient`   | `{}`    | `RelayClientInstallProgressEventSchema` (`relayClient.ts:34`) | **yes** (progress) |

`RelayClientStatusSchema` is a union **discriminated by `status`**
(`available{executablePath,source,version}` | `missing{version}` |
`unsupported{platform,arch,version}`); the progress stream is a union by **`type`**
(`progress{stage}` | `complete{status}`).

### 3.4 Source control (repository provisioning)

`rpc.ts:333-355`. Domain error `SourceControlRepositoryError`.

| tag                               | payload                               | success                                | stream |
| --------------------------------- | ------------------------------------- | -------------------------------------- | ------ |
| `sourceControl.lookupRepository`  | `SourceControlRepositoryLookupInput`  | `SourceControlRepositoryInfo`          | no     |
| `sourceControl.cloneRepository`   | `SourceControlCloneRepositoryInput`   | `SourceControlCloneRepositoryResult`   | no     |
| `sourceControl.publishRepository` | `SourceControlPublishRepositoryInput` | `SourceControlPublishRepositoryResult` | no     |

### 3.5 Projects (workspace files & registry)

`rpc.ts:357-379`. All defined in `packages/contracts/src/project.ts`. Domain
errors `Project{Search,List,Read,Write}EntriesError`.

| tag                      | payload                                               | success                      | stream |
| ------------------------ | ----------------------------------------------------- | ---------------------------- | ------ |
| `projects.searchEntries` | `ProjectSearchEntriesInput` (`{cwd, query, limit,…}`) | `ProjectSearchEntriesResult` | no     |
| `projects.listEntries`   | `ProjectListEntriesInput`                             | `ProjectListEntriesResult`   | no     |
| `projects.readFile`      | `ProjectReadFileInput` (`{cwd, relativePath,…}`)      | `ProjectReadFileResult`      | no     |
| `projects.writeFile`     | `ProjectWriteFileInput`                               | `ProjectWriteFileResult`     | no     |

Wire shapes (`project.ts`): `ProjectListEntriesInput` = `{ cwd }` (`:29`),
`ProjectListEntriesResult` = `{ entries:[{path,kind:"file"|"directory"}], truncated:bool }`
(`:34`). `ProjectReadFileInput` = `{ cwd, relativePath }` (`:119`),
`ProjectReadFileResult` = `{ relativePath, contents:string, byteLength:number, truncated:bool }`
(`:125`). `ProjectSearchEntriesInput` = `{ cwd, query, limit }` (`:8`).
`ProjectWriteFileInput` = `{ cwd, relativePath, contents }` (`:190`),
`ProjectWriteFileResult` = `{ relativePath }` (`:197`). The `*Error` types
(`_tag`-tagged) carry `message` (required) plus optional structured fields
(`failure` literal, `resolvedPath`, `operation`, …) — `:64,97,165,202`.

> Note: `WS_METHODS` also declares `projects.list/add/remove` (`rpc.ts:149-151`),
> but these are **not** added to `WsRpcGroup` and have no `Rpc.make`/handler —
> project CRUD is done through `orchestration.dispatchCommand`
> (`project.create` / `project.meta.update` / `project.delete`). Do not call them.

### 3.6 Shell / filesystem / assets

`rpc.ts:381-396`.

| tag                  | payload                                   | success                  | stream | def          |
| -------------------- | ----------------------------------------- | ------------------------ | ------ | ------------ |
| `shell.openInEditor` | `LaunchEditorInput` (`editor.ts`)         | _(none — void)_          | no     | `rpc.ts:381` |
| `filesystem.browse`  | `FilesystemBrowseInput` (`filesystem.ts`) | `FilesystemBrowseResult` | no     | `:386`       |
| `assets.createUrl`   | `AssetCreateUrlInput` (`assets.ts`)       | `AssetCreateUrlResult`   | no     | `:392`       |

`assets.createUrl` issues an HTTP URL for binary content (images, favicons) served
under the asset route (`apps/server/src/http.ts:176-220`, `ASSET_ROUTE_PREFIX`).
**Binary data is not inlined in RPC frames** — fetch it over HTTP from the issued
URL. Handler: `apps/server/src/ws.ts:1407-1452`. Wire shapes:
`AssetCreateUrlInput` = `{ resource }` where `resource` is a `_tag`-union
(`workspace-file{threadId,path}` | `attachment{attachmentId}` |
`project-favicon{cwd}`, `assets.ts:21`); `AssetCreateUrlResult` =
`{ relativeUrl:string, expiresAt:number (epoch, not ISO) }` (`assets.ts:26`).
`FilesystemBrowseInput` = `{ partialPath:string, cwd? }` (`filesystem.ts:6`);
`FilesystemBrowseResult` = `{ parentPath:string, entries:[{name,fullPath}] }`
(`filesystem.ts:18`). `LaunchEditorInput` = `{ cwd, editor:<EditorId literal> }`
(`editor.ts:47`).

### 3.7 VCS / Git

`rpc.ts:398-468`. Defined in `packages/contracts/src/git.ts`,
`packages/contracts/src/vcs.ts`. Errors: `GitCommandError`,
`GitManagerServiceError`, `VcsError`.

| tag                            | payload                            | success                             | stream             |
| ------------------------------ | ---------------------------------- | ----------------------------------- | ------------------ |
| `subscribeVcsStatus`           | `VcsStatusInput`                   | `VcsStatusStreamEvent`              | **yes**            |
| `vcs.pull`                     | `VcsPullInput`                     | `VcsPullResult`                     | no                 |
| `vcs.refreshStatus`            | `VcsStatusInput`                   | `VcsStatusResult`                   | no                 |
| `vcs.listRefs`                 | `VcsListRefsInput`                 | `VcsListRefsResult`                 | no                 |
| `vcs.createWorktree`           | `VcsCreateWorktreeInput`           | `VcsCreateWorktreeResult`           | no                 |
| `vcs.removeWorktree`           | `VcsRemoveWorktreeInput`           | _(void)_                            | no                 |
| `vcs.createRef`                | `VcsCreateRefInput`                | `VcsCreateRefResult`                | no                 |
| `vcs.switchRef`                | `VcsSwitchRefInput`                | `VcsSwitchRefResult`                | no                 |
| `vcs.init`                     | `VcsInitInput`                     | _(void)_                            | no                 |
| `git.runStackedAction`         | `GitRunStackedActionInput`         | `GitActionProgressEvent`            | **yes** (progress) |
| `git.resolvePullRequest`       | `GitPullRequestRefInput`           | `GitResolvePullRequestResult`       | no                 |
| `git.preparePullRequestThread` | `GitPreparePullRequestThreadInput` | `GitPreparePullRequestThreadResult` | no                 |

Key wire shapes (all in `git.ts`):

- `VcsStatusInput` = `{ cwd:string }` (`git.ts:102`).
- `VcsStatusStreamEvent` (`git.ts:241`) is a **`_tag`-tagged** union
  (`snapshot`/`localUpdated`/`remoteUpdated`) carrying `local`/`remote`
  `VcsStatusResult`-like payloads. `VcsStatusResult` (`git.ts:235`): `{ isRepo:bool,
hasPrimaryRemote:bool, isDefaultRef:bool, refName:string|null,
hasWorkingTreeChanges:bool, workingTree:{files:[{path,insertions,deletions}],
insertions,deletions}, hasUpstream:bool, aheadCount, behindCount, pr:{…}|null }`.
- `GitActionProgressEvent` (`git.ts:437`) — the `git.runStackedAction` stream — is a
  union **discriminated by `kind`**: `action_started | phase_started | hook_started |
hook_output | hook_finished | action_finished | action_failed`, all sharing
  `actionId, cwd, action`.
- `GitCommandError` (`git.ts:323`, `_tag:"GitCommandError"`),
  `GitManagerServiceError` (`git.ts:380`, `_tag`-union), `VcsError`
  (`vcs.ts:269`, `_tag`-union of 9 process/repo error variants).

### 3.8 Review

`rpc.ts:475-479`. `review.getDiffPreview` — payload `ReviewDiffPreviewInput`,
success `ReviewDiffPreviewResult`, error `ReviewDiffPreviewError` (`review.ts`),
not streamed. (Ephemeral live diff preview; not the persisted review model.)

### 3.9 Terminal

`rpc.ts:481-518, 649-661`. Defined in `packages/contracts/src/terminal.ts`. Error
`TerminalError`.

| tag                         | payload                | success                       | stream  |
| --------------------------- | ---------------------- | ----------------------------- | ------- |
| `terminal.open`             | `TerminalOpenInput`    | `TerminalSessionSnapshot`     | no      |
| `terminal.attach`           | `TerminalAttachInput`  | `TerminalAttachStreamEvent`   | **yes** |
| `terminal.write`            | `TerminalWriteInput`   | _(void)_                      | no      |
| `terminal.resize`           | `TerminalResizeInput`  | _(void)_                      | no      |
| `terminal.clear`            | `TerminalClearInput`   | _(void)_                      | no      |
| `terminal.restart`          | `TerminalRestartInput` | `TerminalSessionSnapshot`     | no      |
| `terminal.close`            | `TerminalCloseInput`   | _(void)_                      | no      |
| `subscribeTerminalEvents`   | `{}`                   | `TerminalEvent`               | **yes** |
| `subscribeTerminalMetadata` | `{}`                   | `TerminalMetadataStreamEvent` | **yes** |

Key wire shapes (all in `terminal.ts`): `TerminalSessionSnapshot` (`:96`) =
`{ threadId, terminalId, cwd, worktreePath:string|null,
status:"starting"|"running"|"exited"|"error", pid:number|null, history:string,
exitCode:number|null, exitSignal:number|null, label, updatedAt, sequence? }`.
`TerminalEvent` (`:206`) is a union **discriminated by `type`** (`started | output |
exited | closed | error | cleared | restarted | activity`), each sharing
`threadId, terminalId, sequence?`; `output` carries `{ data:string }` (UTF-8).
`TerminalWriteInput` (`:60`) = `{ threadId, terminalId, data:string(1..65536) }`.
`TerminalMetadataStreamEvent` (`:145`) union by `type`: `snapshot | upsert | remove`.
`TerminalError` (`:344`) is a `_tag`-union of 8 variants.

### 3.10 Preview & preview-automation

`rpc.ts:520-591`. Defined in `packages/contracts/src/preview.ts`,
`previewAutomation.ts`. Errors `PreviewError`, `PreviewAutomationError`.

| tag                               | payload                      | success                        | stream  |
| --------------------------------- | ---------------------------- | ------------------------------ | ------- |
| `preview.open`                    | `PreviewOpenInput`           | `PreviewSessionSnapshot`       | no      |
| `preview.navigate`                | `PreviewNavigateInput`       | `PreviewSessionSnapshot`       | no      |
| `preview.resize`                  | `PreviewResizeInput`         | `PreviewSessionSnapshot`       | no      |
| `preview.refresh`                 | `PreviewRefreshInput`        | _(void)_                       | no      |
| `preview.close`                   | `PreviewCloseInput`          | _(void)_                       | no      |
| `preview.list`                    | `PreviewListInput`           | `PreviewListResult`            | no      |
| `preview.reportStatus`            | `PreviewReportStatusInput`   | _(void)_                       | no      |
| `previewAutomation.connect`       | `PreviewAutomationHost`      | `PreviewAutomationStreamEvent` | **yes** |
| `previewAutomation.respond`       | `PreviewAutomationResponse`  | _(void)_                       | no      |
| `previewAutomation.focusHost`     | `PreviewAutomationHostFocus` | _(void)_                       | no      |
| `subscribePreviewEvents`          | `{}`                         | `PreviewEvent`                 | **yes** |
| `subscribeDiscoveredLocalServers` | `{}`                         | `DiscoveredLocalServerList`    | **yes** |

Key wire shapes (all in `preview.ts`): `PreviewSessionSnapshot` (`:133`) =
`{ threadId, tabId, navStatus:PreviewNavStatus, canGoBack:bool, canGoForward:bool,
viewport?:PreviewViewportSetting, updatedAt }`. `PreviewNavStatus` (`:160` area) and
`PreviewViewportSetting` (`:175` area) are **`_tag`-tagged** unions
(`Idle|Loading|Success|LoadFailed` and `fill|freeform|preset`). `PreviewEvent`
(`:236`) is a union **discriminated by `type`** (`opened|navigated|resized|failed|
closed`). `DiscoveredLocalServerList` (`:264`) = `{ servers:[{host,port,url,
processName:string|null,pid:number|null,terminal:{threadId,terminalId}|null}],
scannedAt:string }`. `PreviewError` (`:297`) `_tag`-union.
Preview-automation (`previewAutomation.ts`): `PreviewAutomationStreamEvent` (`:579`)
union by `type` (`connected|request`); `PreviewAutomationError` (`:833`) is a large
`_tag`-union (14 variants). Automation screenshots are base64 **strings**, not binary.

### 3.11 Streaming subscriptions (server config / lifecycle / auth)

`rpc.ts:398-403, 576-682`.

| tag                        | payload | success                                         | stream  |
| -------------------------- | ------- | ----------------------------------------------- | ------- |
| `subscribeServerConfig`    | `{}`    | `ServerConfigStreamEvent` (`server.ts:504-510`) | **yes** |
| `subscribeServerLifecycle` | `{}`    | `ServerLifecycleStreamEvent` (`server.ts:527+`) | **yes** |
| `subscribeAuthAccess`      | `{}`    | `AuthAccessStreamEvent` (`auth.ts`)             | **yes** |

`ServerConfigStreamEvent` (`server.ts:473-510`) is a union of
`{version:1, type:"snapshot", config}` / `type:"keybindingsUpdated"` /
`type:"providerStatuses"` / `type:"settingsUpdated"` (each carrying `payload`).
`AuthAccessStreamEvent` (`auth.ts:312`) is a union **discriminated by `type`** with
`version:1` + `revision:number`: `snapshot{payload:{pairingLinks[],clientSessions[]}}`,
`pairingLinkUpserted`, `pairingLinkRemoved{payload:{id}}`, `clientUpserted`,
`clientRemoved{payload:{sessionId}}`. `SourceControlDiscoveryResult`
(`sourceControl.ts:147`) uses `Schema.Option` for its `version`/`detail`/`account`/
`host` fields (see §5.4).

**Complete method count:** 66 RPCs registered in `WsRpcGroup`
(`packages/contracts/src/rpc.ts:684-753`): 7 orchestration + 12 server-meta +
2 cloud + 3 source-control + 4 projects + 3 shell/fs/assets + 12 vcs/git +
1 review + 9 terminal + 12 preview + 3 config/lifecycle/auth subscriptions.

---

## 4. Push / subscription model

### 4.1 Mechanism = streaming RPCs (no separate channel)

There is **no separate pub/sub channel and no server-initiated `Request`**. All
server-initiated updates flow through **streaming RPCs** (`stream: true`) that the
_client_ initiates. The server keeps the request open and pushes `Chunk` frames
(each carrying one or more encoded values) for the life of the subscription
(§2.3). The client must `Ack` each `Chunk`.

The streaming subscription RPCs are exactly those marked **stream = yes** in §3:
`orchestration.subscribeShell`, `orchestration.subscribeThread`,
`subscribeVcsStatus`, `subscribeTerminalEvents`, `subscribeTerminalMetadata`,
`subscribePreviewEvents`, `subscribeDiscoveredLocalServers`, `terminal.attach`,
`previewAutomation.connect`, `subscribeServerConfig`, `subscribeServerLifecycle`,
`subscribeAuthAccess`, plus the progress streams `git.runStackedAction`,
`cloud.installRelayClient`.

### 4.2 Snapshot-then-live pattern & ordering

Most subscriptions emit a **snapshot first, then a live tail**, concatenated
server-side with `Stream.concat(Stream.make(snapshot…), liveStream)`:

- `subscribeThread` — `apps/server/src/ws.ts:1113-1171`: first value
  `{kind:"snapshot", snapshot:{snapshotSequence, thread}}`, then
  `{kind:"event", event}` for that thread. `snapshotSequence` tells the client
  which global `sequence` the snapshot already includes.
- `subscribeShell` — `apps/server/src/ws.ts:1062-1095`: `{kind:"snapshot",…}` then
  `project-upserted|project-removed|thread-upserted|thread-removed` deltas, each
  carrying a `sequence` (`orchestration.ts:421-452`).
- `subscribeServerConfig` — `apps/server/src/ws.ts:1691-1741`: `{type:"snapshot",
config}` then `keybindingsUpdated|providerStatuses|settingsUpdated`.
- `subscribeServerLifecycle` — `apps/server/src/ws.ts:1742-1756`: replays sorted
  historical events (by `sequence`) then the live tail filtered to
  `sequence > snapshot.sequence`.
- `subscribeAuthAccess` — `apps/server/src/ws.ts:1757-1788`: snapshot (`revision:1`)
  then monotonically-increasing `revision` deltas.

**Ordering guarantees.** Within a single subscription stream, frames are ordered
(the WebSocket + the per-chunk Ack backpressure preserve order). Cross-cutting
ordering is via the monotonic `sequence` integer on orchestration events
(`orchestration.ts:990`) and `snapshotSequence`/`revision` counters. The client
should treat `sequence` as the source of truth for dedup/reordering, since a
reconnect produces a _new_ snapshot that overlaps previously-seen events.

### 4.3 Re-subscription after reconnect

There is **no resumption token or server-side replay-on-reconnect**. When the
socket drops, the Effect RPC socket does not auto-reconnect (§1.5); the connection
supervisor establishes a fresh socket and the client re-issues **all** its RPCs
from scratch — a new `server.getConfig`, and a new `subscribe*` for each stream,
each of which returns a fresh snapshot. To avoid missing events across the gap,
the client can use `orchestration.replayEvents({ fromSequenceExclusive })`
(§3.1) to fetch every event after the last `sequence` it processed, then reconcile
against the new snapshot's `snapshotSequence`.

A Swift client should therefore: track the highest `sequence` seen; on reconnect,
re-subscribe (getting a snapshot) and/or call `replayEvents` from the last known
sequence; dedup by `sequence`/`eventId`.

---

## 5. Schema encoding conventions (for Swift `Codable`)

Payloads/successes/errors are encoded with each RPC's Effect `Schema` via the
JSON codec (`Schema.toCodecJson`, server side
`effect/src/unstable/rpc/RpcServer.ts:633-639`). Conventions that affect Swift
types:

### 5.1 Dates / times → ISO-8601 strings

- The pervasive `IsoDateTime` is literally `Schema.String`
  (`packages/contracts/src/baseSchemas.ts:20-21`) — a plain ISO-8601 string,
  **not** validated, e.g. `"2026-07-04T12:00:00.000Z"`. Server generates them via
  `DateTime.formatIso` (`apps/server/src/ws.ts:117`).
- `Schema.DateTimeUtc` — used **pervasively** in the diagnostics/auth/vcs/review/
  sourceControl result schemas (e.g. `server.ts` trace/process `readAt`,
  `lastSeenAt`, bucket `startedAt/endedAt`; `auth.ts` `expiresAt/issuedAt/
createdAt/lastConnectedAt`; `review.ts` `generatedAt`) — also encodes to/from an
  ISO-8601 UTC **string** (`effect/src/Schema.ts:11412-11428`, `toCodecJson →
String` via `dateTimeUtcFromString`). Not the `[epochMillis, offset]` tuple form.
  There is **no** `Schema.Date` anywhere on this surface.
- **Numeric "time" fields that are NOT date strings** (watch out):
  `AssetCreateUrlResult.expiresAt` is an **epoch number** (`assets.ts:26`);
  `ServerSettings.automaticGitFetchInterval` is a **number of milliseconds**
  (`Schema.DurationFromMillis`, `settings.ts`); `AuthAccessTokenResult.expires_in`
  is a number of seconds.
- **Swift:** decode ISO timestamp fields as `String` (or a custom ISO8601 `Date`
  strategy); decode the three fields above as numbers.

### 5.2 Branded IDs → plain strings

All entity IDs (`ThreadId`, `ProjectId`, `CommandId`, `EventId`, `MessageId`,
`TurnId`, `ProviderInstanceId`, `CheckpointRef`, `AuthSessionId`, …) are
`TrimmedNonEmptyString.pipe(Schema.brand(...))`
(`packages/contracts/src/baseSchemas.ts:26-60`). The brand is **erased on the
wire** — they are ordinary non-empty strings. Model them as `String` in Swift.

### 5.3 Optionality — three distinct encodings

- `Schema.optional(x)` → the **key may be absent** (or present). On encode, when
  the value is `undefined` the key is omitted. Model as a Swift optional
  (`?`), and be prepared for the key to be missing entirely.
- `Schema.optionalKey(x)` → same "absent key" behavior (used e.g.
  `ignoreWhitespace` `orchestration.ts:1194`).
- `Schema.NullOr(x)` → the key is **present** with value `x` **or JSON `null`**
  (e.g. `branch: string | null`). Model as Swift optional but expect explicit
  `null`, not an absent key.
- `Schema.optional(Schema.NullOr(x))` → key may be absent _or_ present-and-null.
- **`withDecodingDefault`**: several fields are decoded with a default when
  absent, so the server can **omit** them: `runtimeMode` (dflt `"full-access"`),
  `interactionMode` (dflt `"default"`), `archivedAt` (dflt `null`),
  `proposedPlans` (dflt `[]`) — see `orchestration.ts:844-846,358,361-363`. A
  Swift decoder must supply these defaults when the key is missing.

### 5.4 Options as objects

`Schema.Option(x)` encodes as `{ "_tag": "None" }` or
`{ "_tag": "Some", "value": … }` (`effect/src/Schema.ts:8191-8199,8248`) — a
**tagged object, not a bare `null`**. This is a real (not merely theoretical) shape
on this wire: it is used for value fields in `server.ts` diagnostics results
(e.g. trace `firstSpanAt/lastSpanAt/error`, process `pgid`, signal `message`),
`vcs.ts`, and `sourceControl.ts` (`SourceControlDiscoveryResult` `version`/`detail`/
`account`/`host` fields, `sourceControl.ts:147`). So a field may be `null` (from
`NullOr`), an **absent key** (from `optional`), or a `{_tag:"None"|"Some"}` object
(from `Option`) — three distinct "no value" encodings; check the schema.

### 5.5 Unions & discriminators — key varies by union

Effect unions are **not** uniformly `_tag`-discriminated. The discriminator field
depends on the schema:

- **`_tag`** — protocol envelopes (§2), tagged errors, tagged classes
  (`ConnectionTarget` `model.ts:41-46`, all `*Error` types).
- **`type`** — `OrchestrationCommand` (`orchestration.ts:465+`),
  `OrchestrationEvent` (`:1001+`), `ServerConfigStreamEvent` (`server.ts:504-510`,
  additionally tagged with `version:1`).
- **`kind`** — orchestration stream items: `OrchestrationThreadStreamItem`
  (`snapshot|event`, `:1115-1124`), `OrchestrationShellStreamItem`/`StreamEvent`
  (`snapshot|project-upserted|project-removed|thread-upserted|thread-removed`,
  `:421-452`).
- **`status`**, **`tone`**, etc. — plain string-literal enums
  (`Schema.Literals([...])`), encoded as bare strings.
  Inspect the specific schema to pick the discriminator; do not assume `_tag`.

### 5.6 Errors, causes & defects

- A declared (expected) RPC error arrives inside an `Exit.Failure.cause` as
  `{"_tag":"Fail","error":{ "_tag":"<ErrorName>", …fields }}` (§2.2). Error
  structs are `Schema.TaggedError…`, so they carry their own `_tag` plus fields
  (e.g. `EnvironmentAuthorizationError { _tag, message, requiredScope }`).
- Unexpected crashes arrive as `{"_tag":"Die","defect":<json>}`. `Schema.Defect()`
  encodes a JS `Error` as `{ name, message, cause? }` and arbitrary values as
  their JSON form (`effect/src/Schema.ts:9130-9174`); it is **best-effort and
  lossy** — treat `defect` as opaque diagnostic JSON.
- Some error schemas embed a `cause: Schema.optional(Schema.Defect())` field
  (e.g. `OrchestrationDispatchCommandError` `orchestration.ts:1260-1266`).

### 5.7 Strings with checks

`TrimmedNonEmptyString`/`TrimmedString` **trim on decode & encode**
(`baseSchemas.ts:5-14`) and reject empty; `NonNegativeInt`/`PositiveInt`/`PortSchema`
enforce numeric ranges (`:16-18`). The server rejects violating payloads with a
decode failure (surfaced as a `Die`/protocol error). The Swift client should send
already-trimmed, in-range values.

### 5.8 Binary & secrets

No inline binary and **no `Schema.Uint8Array`/`Schema.Redacted`** anywhere on the
WS surface (the sole `Schema.Uint8Array` in contracts is `ipc.ts:914`, a desktop
IPC channel, not this WS group). Images/assets go through `assets.createUrl` → HTTP
asset route (§3.6); preview-automation screenshots are base64 **strings**; terminal
I/O is UTF-8 text within `TerminalWriteInput`/`TerminalEvent`. Secrets in settings
(`serverPassword`, provider tokens, `ProviderInstanceEnvironmentVariable.value`) are
plain `Schema.String` on the wire — the server redacts them for the client before
sending (`ServerSettings.redactServerSettingsForClient`, applied in
`apps/server/src/ws.ts:910,1214-1215,1714`), so read-back values may be masked, but
the type is still just a string, with a sibling `sensitive`/`valueRedacted` boolean.

### 5.9 `_tag` literals ≠ class names (gotcha)

A tagged error's `_tag` string is not always the TypeScript class name. Notably
`KeybindingsConfigError`'s wire `_tag` is **`"KeybindingsConfigParseError"`**
(`keybindings.ts:160`), which is exactly what the reference client switches on
(`packages/client-runtime/src/rpc/session.ts:53`). Match on the literal `_tag`
value from the schema, never the exported symbol name.

---

## 6. Risks & versioning notes for an independent Swift implementation

1. **Unstable Effect RPC envelope.** Everything in §2 comes from
   `effect/unstable/rpc` at `effect@4.0.0-beta.78`
   (`node_modules/.pnpm/effect@4.0.0-beta.78_patch_hash=c502bc684210b707dfceb87d8fe6ad6843395af6e19cfc02cd65854898bde2c5`).
   The `_tag`/`Chunk`/`Exit` framing, the Ack protocol, and the ping cadence are
   internal and **not a stable public contract** — they can change on any Effect
   bump. Pin behavior to this version and add a protocol conformance test.

2. **Ack backpressure is mandatory (easy to miss).** Failing to `Ack` each
   `Chunk` stalls every stream after the first chunk (§2.3). This is the single
   most likely bug in a from-scratch client.

3. **Application-level ping is mandatory for liveness.** The server won't proactively
   close on silence, but the _client_ must send `{"_tag":"Ping"}` every 5 s and
   watch for `{"_tag":"Pong"}`; ~10 s without a pong should be treated as dead
   (§1.4). Do not rely solely on TCP/WS control-frame keepalives.

4. **No reconnect resume.** The socket does not auto-reconnect and there is no
   resumption token. You must re-`server.getConfig`, re-`subscribe*`, and
   optionally `replayEvents(fromSequenceExclusive)` after every reconnect, then
   dedup by `sequence`/`eventId` (§4.3). Snapshots overlap prior events.

5. **Discriminator field is not uniform** (`_tag` vs `type` vs `kind`) — §5.5.
   A generic "decode by `_tag`" will mis-parse orchestration commands/events and
   stream items.

6. **`withDecodingDefault` fields may be omitted by the server** — your decoder
   must inject defaults for `runtimeMode`, `interactionMode`, `archivedAt`,
   `proposedPlans` (§5.3), or decoding fails on real payloads.

7. **`ModelSelection` legacy transform.** Always send `{ instanceId, model }`;
   the legacy `{ provider, model }` shape is only accepted via a decode-time
   promotion (`orchestration.ts:85-102`) and should not be emitted by a new client.

8. **Ticket lifecycle.** `wsTicket` is short-lived (`expiresAt` in the ticket
   result) and must be minted per connection via `POST /api/auth/websocket-ticket`
   with a valid access token. A stale ticket → upgrade rejected (401-class). The
   header-based (`Authorization: Bearer/DPoP`) upgrade path is available to native
   clients as an alternative (§1.2).

9. **Scope errors are in-band, not fatal.** `EnvironmentAuthorizationError` comes
   back as a normal `Exit.Failure` for the offending call; the socket stays open
   (§1.2). Handle it per-request.

10. **Request `id` uniqueness.** Ids are opaque strings but must be unique among
    in-flight requests on the connection; reusing an id while a prior request is
    open will cross-wire responses (`RpcClient.ts:1069-1077` routes by
    `requestId`). A per-connection incrementing counter (as string) is safest.

11. **Untyped/opaque fields.** `OrchestrationThreadActivity.payload` is
    `Schema.Unknown` (`orchestration.ts:318`) and defect `cause`s are opaque JSON —
    model these as free-form JSON (`AnyCodable`) in Swift.

12. **Trimming/normalization.** The server trims strings and enforces int ranges
    on decode (§5.7); send normalized values to avoid surprising
    round-trip differences.

---

### Appendix A — canonical example frames (reconstructed)

Client opens `wss://127.0.0.1:3773/ws?wsTicket=…`, then:

```jsonc
// C→S  invoke server.getConfig  (id 0)
{"_tag":"Request","id":"0","tag":"server.getConfig","payload":{},"headers":[]}

// S→C  success exit
{"_tag":"Exit","requestId":"0","exit":{"_tag":"Success","value":{ /* ServerConfig */ }}}

// C→S  subscribe to a thread (streaming; id 1)
{"_tag":"Request","id":"1","tag":"orchestration.subscribeThread",
 "payload":{"threadId":"th_123"},"headers":[]}

// S→C  first chunk = snapshot
{"_tag":"Chunk","requestId":"1","values":[
  {"kind":"snapshot","snapshot":{"snapshotSequence":100,"thread":{ /* OrchestrationThread */ }}}]}

// C→S  MUST ack to receive more
{"_tag":"Ack","requestId":"1"}

// S→C  live event chunk
{"_tag":"Chunk","requestId":"1","values":[
  {"kind":"event","event":{"sequence":101,"type":"thread.message-sent","aggregateKind":"thread",
   "aggregateId":"th_123","occurredAt":"2026-07-04T12:00:00.000Z","eventId":"ev_9",
   "commandId":null,"causationEventId":null,"correlationId":null,"metadata":{},
   "payload":{ /* ThreadMessageSentPayload */ }}}]}
{"_tag":"Ack","requestId":"1"}

// heartbeat (every 5s)
{"_tag":"Ping"}          // C→S
{"_tag":"Pong"}          // S→C

// C→S  start a turn (write via dispatchCommand; id 2)
{"_tag":"Request","id":"2","tag":"orchestration.dispatchCommand","headers":[],
 "payload":{"type":"thread.turn.start","commandId":"cmd_1","threadId":"th_123",
   "message":{"messageId":"m_1","role":"user","text":"hi","attachments":[]},
   "runtimeMode":"full-access","interactionMode":"default","createdAt":"2026-07-04T12:00:01.000Z"}}
{"_tag":"Exit","requestId":"2","exit":{"_tag":"Success","value":{"sequence":102}}}

// C→S  cancel the subscription
{"_tag":"Interrupt","requestId":"1"}

// example failure exit (scope missing)
{"_tag":"Exit","requestId":"3","exit":{"_tag":"Failure","cause":[
  {"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError",
    "message":"The authenticated token is missing required scope: …","requiredScope":"…"}}]}}
```

_(Frames reconstructed from the envelope schemas and serialization code cited
above; field values are illustrative.)_
