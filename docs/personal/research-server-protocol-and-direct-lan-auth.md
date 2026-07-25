# t3code server protocol & direct-LAN auth

Research for [issue #2](https://github.com/r4iju/t3-code/issues/2). Read against upstream
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) @ main, 2026-07-23 (shallow clone at
`~/code/t3code-upstream`). File references below are paths in that repo.

## TL;DR

- **Transport:** one WebSocket at `/ws` carrying **Effect RPC with JSON serialization** (not tRPC,
  not REST-per-call, not SSE). A small plain-HTTP surface handles auth, assets, and the SPA.
  Streaming (agent output, terminals, VCS status) is RPC streams multiplexed on that same socket.
- **Direct LAN is first-class and relay-free.** `t3 serve --host <lan-ip>` (or the desktop app's
  _Settings → Connections → Network access_ toggle) binds beyond loopback and prints/shows a
  one-time pairing token + QR. Clerk / T3 Connect is an optional NAT-traversal add-on, disabled in
  a fresh clone.
- **The official mobile app already supports exactly our target flow:** an "Add Environment"
  screen with Host + pairing-code fields (and QR scan) that exchanges the token for a bearer
  session and connects directly over `ws://<lan-ip>:3773/ws` — no cloud account, no relay.
- **Protocol reuse outside the monorepo is possible but heavy:** the protocol packages are clean
  of platform coupling but private, unbuilt, workspace-only, and pinned to an Effect 4.0 _beta_.
  A greenfield client means vendoring three packages and reimplementing the platform seam the
  upstream mobile app already implements.

## Protocol map

**Primary transport** — `GET /ws` upgrades to a WebSocket serving the `WsRpcGroup` RPC group from
`@t3tools/contracts` via `RpcServer.toHttpEffectWebsocket` with `RpcSerialization.layerJson`
(`apps/server/src/ws.ts:2086-2150`). The per-method authorization-scope map at `ws.ts:288-359` is
effectively the API catalog: `dispatchCommand`, `getTurnDiff`, `subscribeShell`, `subscribeThread`,
`terminal*`, `preview*`, `vcs*`, `git*`, `projects*`, and the `subscribe*` stream family. Agent
output arrives as `thread.*` orchestration events through `subscribeShell`/`subscribeThread` RPC
streams, coalesced server-side (`ws.ts:793-838`).

**Auxiliary HTTP** (`apps/server/src/server.ts:350-369`): the `EnvironmentHttpApi` (Effect HttpApi;
groups `metadata`, `auth`, `orchestration`, `connect` — defined in
`packages/contracts/src/environmentHttp.ts`), an OTLP trace proxy, asset routes, an MCP HTTP
server, and a static fallback serving the bundled web client.

**Listen address** — default port **3773** (`apps/server/src/config.ts:17`), binding falls back to
`127.0.0.1` unless `--host`/`T3CODE_HOST` is set (`apps/server/src/server.ts:129-144`). The desktop
app's Network-access toggle rebinds to `0.0.0.0` and advertises the LAN IPv4
(`apps/desktop/src/backend/DesktopServerExposure.ts:30-134`).

**CORS** — packaged builds send `access-control-allow-origin: *` (auth is the gate, not CORS;
`apps/server/src/http.ts:45-60`). A native app is outside CORS anyway: it needs only reachability
plus a valid credential.

## Auth for a direct connection

There is **no anonymous path, even on loopback** — every request and WS upgrade authenticates
against a scoped session (`apps/server/src/auth/EnvironmentAuth.ts:591,936`). The bootstrap chain:

1. Server issues a **one-time pairing token**. Headless: `t3 serve` prints connection string,
   token, pairing URL (`http://<host>:<port>/pair#token=...`) and a QR code
   (`apps/server/src/startupAccess.ts:122-148`). Desktop seeds an unbounded bootstrap token for
   its own renderer.
2. Client exchanges it at **`POST /oauth/token`** (RFC 8693 token-exchange shape) for an opaque
   **bearer session token** (`EnvironmentAuth.ts:690`).
3. Bearer is traded at **`POST /api/auth/websocket-ticket`** for a short-lived single-use ticket,
   passed as `/ws?wsTicket=...` so tokens stay out of URLs.

Sessions persist (SQLite + chmod-600 secrets under the server state dir); `t3 auth` issues extra
pairing credentials and lists/revokes sessions. Ordinary pairing grants scopes
`orchestration:read/operate terminal:operate review:write relay:read`.

**The Clerk / T3 Connect relay is optional and off by default** ("disabled in a fresh clone" —
`docs/cloud/t3-connect-clerk.md`). It adds a hosted cloudflared tunnel and a separate credential
system (Clerk JWTs + DPoP); it is irrelevant to our LAN-only scope. `packages/tailscale` and
`packages/ssh` are likewise optional access-method providers that converge on the same WS +
pairing model.

## The mobile direct-LAN flow (already implemented upstream)

`apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx` is an "Add Environment" screen
with a Host field (placeholder `192.168.1.100:8080`), a pairing-code field, and a QR scanner. It
builds a pairing URL, runs `preparePairingRegistration`
(`packages/client-runtime/src/connection/onboarding.ts:86-119`), and registers a relay-free
`BearerConnectionTarget` (`packages/client-runtime/src/connection/model.ts:18-46`).

Recipe: `t3 serve --host <lan-ip>` → scan the printed QR from the phone (or type
`http://<lan-ip>:3773` + code). One caveat: a bare `host:port` without scheme is normalized to
**`https://`** (`packages/shared/src/remote.ts:85-87`), so plain-HTTP LAN servers need the
explicit `http://` prefix — or the QR, which carries it.

## Reusability of the protocol packages

- `@t3tools/contracts` (Effect Schema + Effect RPC/HttpApi contract definitions) and
  `@t3tools/client-runtime` (connection lifecycle, RPC session, ~55 files of client state reducers
  exposed as Effect Atoms) are **platform-clean**: no React/DOM/Node/Expo imports; WebSocket and
  fetch are injected. React binding comes from `@effect/atom-react` in the consuming app.
- But they are **private, versionless (client-runtime), unbuilt (exports point at raw `.ts`),
  workspace-only (`workspace:*` deps incl. `@t3tools/shared`), unpublished**, and the whole stack
  is pinned to **Effect `4.0.0-beta.78`** using `effect/unstable/*` APIs that can break between
  betas.
- A consumer must implement the `platform/` seam (capability + persistence + connection-source
  Layers) — upstream mobile does this with `expo-network`, RN `AppState`, `expo-sqlite`,
  `expo-secure-store` (`apps/mobile/src/connection/platform.ts`, `src/persistence/`,
  `src/lib/runtime.ts`).
- `apps/mobile` is mostly UI on top of that layer, plus **five local Expo native modules**
  (Swift/Kotlin): a libghostty-based terminal surface, native diff renderer, composer editor,
  native controls, and selectable markdown text. These are the hardest parts to port and the main
  reason a from-scratch client is expensive.

## Implications for the fork-vs-greenfield decision (issue #4)

- Greenfield ≠ "just call an HTTP API": the protocol is Effect RPC over WS with contracts living
  in unpublished beta-pinned packages. A greenfield app either vendors
  `contracts`+`client-runtime`+`shared` and adopts Effect wholesale, or reimplements the wire
  protocol by hand against a moving target.
- Building inside a fork keeps `workspace:*` resolution, the working platform-seam glue, and the
  native modules for free; the decent-measure influence would then be limited to release/tooling
  style rather than repo structure.
- Either way, connectivity/auth is a non-issue for our scope: the direct-LAN pairing flow exists,
  is relay-free, and is the documented recommended path.
