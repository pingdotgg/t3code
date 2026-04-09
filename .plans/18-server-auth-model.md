# Server Auth Model Plan

## Purpose

Define the long-term server auth architecture for T3 Code before first-class remote environments ship.

This plan is deliberately broader than the current WebSocket token check and narrower than a complete remote collaboration system. The goal is to make the server secure by default, keep local desktop UX frictionless, and leave clean integration points for future remote access methods.

This document is written in terms of Effect-native services and layers because auth needs to be a core runtime concern, not route-local glue code.

## Primary goals

- Make auth server-wide, not WebSocket-only.
- Make insecure exposure hard to do accidentally.
- Preserve zero-login local desktop UX for desktop-managed environments.
- Support browser-native pairing and session auth.
- Leave room for native/mobile credentials later without rewriting the server boundary.
- Keep auth separate from transport and launch method.

## Non-goals

- Full multi-user authorization and RBAC.
- OAuth / SSO / enterprise identity.
- Passkeys or biometric UX in v1.
- Syncing auth state across environments.
- Designing the full remote environment product in this document.

## Core decisions

### 1. Auth is a server concern

Every privileged surface of the T3 server must go through the same auth policy engine:

- HTTP routes
- WebSocket upgrades
- RPC methods reached through WebSocket

The current split where [`/ws`](../apps/server/src/ws.ts) checks `authToken` but routes in [`http.ts`](../apps/server/src/http.ts) do not is not sufficient for a remote-capable product.

### 2. Pairing and session are different things

The system should distinguish:

- bootstrap credentials
- session credentials

Bootstrap credentials are short-lived and high-trust. They allow a client to become authenticated.

Session credentials are the durable credentials used after pairing.

Bootstrap should never become the long-lived request credential.

### 3. Auth and transport are separate

Auth must not be defined by how the client reached the server.

Examples:

- local desktop-managed server
- LAN `ws://`
- public `wss://`
- tunneled `wss://`
- SSH-forwarded `ws://127.0.0.1:<port>`

All of these should feed into the same auth model.

### 4. Exposure level changes defaults

The more exposed an environment is, the narrower the safe default should be.

Safe default expectations:

- local desktop-managed: auto-pair allowed
- loopback browser access: explicit bootstrap allowed
- non-loopback bind: auth required
- tunnel/public endpoint: auth required, explicit enablement required

### 5. Browser and native clients may use different session credentials

The auth model should support more than one session credential type even if only one ships first.

Examples:

- browser session cookie
- native bearer/device token

This should be represented in the model now, even if browser cookies are the first implementation.

## Target auth domain

### Route classes

Every route or transport entrypoint should be classified as one of:

1. `public`
2. `bootstrap`
3. `authenticated`

#### `public`

Unauthenticated by definition.

Should be extremely small. Examples:

- static shell needed to render the pairing/login UI
- favicon/assets required for the pairing screen
- a minimal server health/version endpoint if needed

#### `bootstrap`

Used only to exchange a bootstrap credential for a session.

Examples:

- Initial bootstrap envelope over file descriptor at startup
- `POST /api/auth/bootstrap`
- `GET /api/auth/session` if unauthenticated checks are part of bootstrap UX

#### `authenticated`

Everything that reveals machine state or mutates it.

Examples:

- WebSocket upgrade
- orchestration snapshot and events
- terminal open/write/close
- project search and file writes
- git routes
- attachments
- project favicon lookup
- server settings

The default stance should be: if it touches the machine, it is authenticated.

## Credential model

### Bootstrap credentials

Initial credential types to model:

- `desktop-bootstrap`
- `one-time-token`

Possible future credential types:

- `device-code`
- `passkey-assertion`
- `external-identity`

#### `desktop-bootstrap`

Used when the desktop shell manages the server and should be the only default pairing method for desktop-local environments.

Properties:

- launcher-provided
- short-lived
- one-time or bounded-use
- never shown to the user as a reusable password

#### `one-time-token`

Used for explicit browser/mobile pairing flows.

Properties:

- short TTL
- one-time use
- safe to embed in a pairing URL fragment
- exchanged for a session credential

### Session credentials

Initial credential types to model:

- `browser-session-cookie`
- `bearer-session-token`

#### `browser-session-cookie`

Primary browser credential.

Properties:

- signed
- `HttpOnly`
- bounded lifetime
- revocable by server key rotation or session invalidation

#### `bearer-session-token`

Reserved for native/mobile or non-browser clients.

Properties:

- opaque token, not a bootstrap secret
- long enough lifetime to survive reconnects
- stored in secure client storage when available

## Auth policy model

Auth behavior should be driven by an explicit environment auth policy, not route-local heuristics.

### Policy examples

#### `DesktopManagedLocalPolicy`

Default for desktop-managed local server.

Allowed bootstrap methods:

- `desktop-bootstrap`

Allowed session methods:

- `browser-session-cookie`

Disabled by default:

- `one-time-token`
- `bearer-session-token`
- password login
- public pairing

#### `LoopbackBrowserPolicy`

Used for browser access on localhost without desktop-managed bootstrap.

Allowed bootstrap methods:

- `one-time-token`

Allowed session methods:

- `browser-session-cookie`

#### `RemoteReachablePolicy`

Used when binding non-loopback or using an explicit remote/tunnel workflow.

Allowed bootstrap methods:

- `one-time-token`
- possibly `desktop-bootstrap` when a desktop shell is brokering access

Allowed session methods:

- `browser-session-cookie`
- `bearer-session-token`

#### `UnsafeNoAuthPolicy`

Should exist only as an explicit escape hatch.

Requirements:

- explicit opt-in flag
- loud startup warnings
- never defaulted automatically

## Effect-native service model

### `ServerAuth`

The main auth facade used by HTTP routes and WebSocket upgrade handling.

Responsibilities:

- classify requests
- authenticate requests
- authorize bootstrap attempts
- create sessions from bootstrap credentials
- enforce policy by environment mode

Sketch:

```ts
export interface ServerAuthShape {
  readonly getCapabilities: Effect.Effect<AuthCapabilities>;
  readonly authenticateHttpRequest: (
    request: HttpServerRequest.HttpServerRequest,
    routeClass: RouteAuthClass,
  ) => Effect.Effect<AuthContext, AuthError>;
  readonly authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthContext, AuthError>;
  readonly exchangeBootstrapCredential: (
    input: BootstrapExchangeInput,
  ) => Effect.Effect<SessionGrant, AuthError>;
}

export class ServerAuth extends ServiceMap.Service<ServerAuth, ServerAuthShape>()(
  "t3/ServerAuth",
) {}
```

### `BootstrapCredentialService`

Owns issuance, storage, validation, and consumption of bootstrap credentials.

Responsibilities:

- issue desktop bootstrap grants
- issue one-time pairing tokens
- validate TTL and single-use semantics
- consume bootstrap grants atomically

Sketch:

```ts
export interface BootstrapCredentialServiceShape {
  readonly issueDesktopBootstrap: (
    input: IssueDesktopBootstrapInput,
  ) => Effect.Effect<BootstrapCredential>;
  readonly issueOneTimeToken: (
    input: IssueOneTimeTokenInput,
  ) => Effect.Effect<BootstrapCredential>;
  readonly consume: (
    presented: PresentedBootstrapCredential,
  ) => Effect.Effect<ConsumedBootstrapCredential, BootstrapCredentialError>;
}
```

### `SessionCredentialService`

Owns creation and validation of authenticated sessions.

Responsibilities:

- mint cookie sessions
- mint bearer sessions
- validate active session credentials
- revoke sessions if needed later

Sketch:

```ts
export interface SessionCredentialServiceShape {
  readonly createBrowserSession: (
    input: CreateSessionFromBootstrapInput,
  ) => Effect.Effect<BrowserSessionGrant, SessionCredentialError>;
  readonly createBearerSession: (
    input: CreateSessionFromBootstrapInput,
  ) => Effect.Effect<BearerSessionGrant, SessionCredentialError>;
  readonly authenticateCookie: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthContext, SessionCredentialError>;
  readonly authenticateBearer: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthContext, SessionCredentialError>;
}
```

### `ServerAuthPolicy`

Pure policy/config service that decides which credential types are allowed.

Responsibilities:

- map runtime mode and bind/exposure settings to allowed auth methods
- answer whether a route can be public
- answer whether remote exposure requires auth

This should stay mostly pure and cheap to test.

### `ServerSecretStore`

Owns long-lived server signing keys and secrets.

Responsibilities:

- get or create signing key
- rotate signing key
- abstract secure OS-backed storage vs filesystem fallback

Important:

- prefer platform secure storage when available
- support hardened filesystem fallback for headless/server-only environments

### `BrowserSessionCookieCodec`

Focused utility service for cookie encode/decode/signing behavior.

This should not own policy. It should only own the cookie format.

### `AuthRouteGuards`

Thin helper layer used by routes to enforce auth consistently.

Responsibilities:

- require auth for HTTP route handlers
- classify route auth mode
- convert auth failures into `401` / `403`

This prevents every route from re-implementing the same pattern.

Integrates with `HttpRouter.middleware` to enforce auth consistently.

## Suggested layer graph

```text
ServerSecretStore
  ├─> BootstrapCredentialService
  ├─> BrowserSessionCookieCodec
  └─> SessionCredentialService

ServerAuthPolicy
  ├─> BootstrapCredentialService
  ├─> SessionCredentialService
  └─> ServerAuth

ServerAuth
  └─> AuthRouteGuards
```

Layer naming should follow existing repo style:

- `ServerSecretStoreLive`
- `BootstrapCredentialServiceLive`
- `SessionCredentialServiceLive`
- `ServerAuthPolicyLive`
- `ServerAuthLive`
- `AuthRouteGuardsLive`

## High-level implementation examples

### Example: WebSocket upgrade auth

Current state:

- `authToken` query param is checked in [`ws.ts`](../apps/server/src/ws.ts)

Target shape:

```ts
const websocketUpgradeAuth = HttpMiddleware.make((httpApp) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateWebSocketUpgrade(request);
    return yield* httpApp;
  }),
);
```

Then the `/ws` route becomes:

```ts
export const websocketRpcRouteLayer = HttpRouter.add(
  "GET",
  "/ws",
  rpcWebSocketHttpEffect.pipe(
    websocketUpgradeAuth,
    Effect.catchTag("AuthError", (error) => toUnauthorizedResponse(error)),
  ),
);
```

This keeps the route itself declarative and makes auth compose like normal HTTP middleware.

### Example: authenticated HTTP route

For routes like attachments or project favicon:

```ts
const authenticatedRoute = (routeClass: RouteAuthClass) =>
  HttpMiddleware.make((httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const serverAuth = yield* ServerAuth;
      yield* serverAuth.authenticateHttpRequest(request, routeClass);
      return yield* httpApp;
    }),
  );
```

Then:

```ts
export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  serveAttachment.pipe(
    authenticatedRoute(RouteAuthClass.Authenticated),
    Effect.catchTag("AuthError", (error) => toUnauthorizedResponse(error)),
  ),
);
```

### Example: desktop bootstrap exchange

The desktop shell launches the local server and gets a short-lived bootstrap grant through a trusted side channel.

That grant is then exchanged for a browser cookie session when the renderer loads.

Sketch:

```ts
const pairDesktopRenderer = Effect.gen(function* () {
  const bootstrapService = yield* BootstrapCredentialService;
  const credential = yield* bootstrapService.issueDesktopBootstrap({
    audience: "desktop-renderer",
    ttlMs: 30_000,
  });
  return credential;
});
```

The renderer then calls a bootstrap endpoint and receives a cookie session. The bootstrap credential is consumed and becomes invalid.

### Example: one-time pairing URL

For browser-driven pairing:

```ts
const createPairingToken = Effect.gen(function* () {
  const bootstrapService = yield* BootstrapCredentialService;
  return yield* bootstrapService.issueOneTimeToken({
    ttlMs: 5 * 60_000,
    audience: "browser",
  });
});
```

The server can emit a pairing URL where the token lives in the URL fragment so it is not automatically sent to the server before the client explicitly exchanges it.

## Sequence diagrams

These flows are meant to anchor the auth model in concrete user journeys.

The important invariant across all of them is:

- access method is not the auth method
- launch method is not the auth method
- bootstrap credential is not the session credential

### Normal desktop user

This is the default desktop-managed local flow.

The desktop shell is trusted to bootstrap the local renderer, but the renderer should still exchange that one-time bootstrap grant for a normal browser session cookie.

```text
Participants:
  DesktopMain   = Electron main
  SecretStore   = secure local secret backend
  T3Server      = local backend child process
  Frontend      = desktop renderer

DesktopMain -> SecretStore : getOrCreate("server-signing-key")
SecretStore --> DesktopMain : signing key available

DesktopMain -> T3Server : spawn server (--bootstrap-fd ...)
DesktopMain -> T3Server : send desktop bootstrap envelope
note over T3Server : policy = DesktopManagedLocalPolicy
note over T3Server : allowed pairing = desktop-bootstrap only

Frontend -> DesktopMain : request local bootstrap grant
DesktopMain --> Frontend : short-lived desktop bootstrap grant

Frontend -> T3Server : POST /api/auth/bootstrap
T3Server -> T3Server : validate desktop bootstrap grant
T3Server -> T3Server : create browser session
T3Server --> Frontend : Set-Cookie: session=...

Frontend -> T3Server : GET /ws + authenticated cookie
T3Server -> T3Server : validate cookie session
T3Server --> Frontend : websocket accepted
```

### `npx t3` user

This is the standalone local server flow.

There is no trusted desktop shell here, so pairing should be explicit.

```text
Participants:
  UserShell     = npx t3 launcher
  T3Server      = standalone local server
  Browser       = browser tab

UserShell -> T3Server : start server
T3Server -> T3Server : getOrCreate("server-signing-key")
note over T3Server : policy = LoopbackBrowserPolicy

UserShell -> T3Server : issue one-time pairing token
T3Server --> UserShell : pairing URL or pairing token

UserShell --> Browser : open /pair?token=...

Browser -> T3Server : GET /pair?token=...
T3Server -> T3Server : validate one-time token
T3Server -> T3Server : create browser session
T3Server --> Browser : Set-Cookie: session=...
T3Server --> Browser : redirect to app

Browser -> T3Server : GET /ws + authenticated cookie
T3Server --> Browser : websocket accepted
```

### Phone user with tunneled host

This is the explicit remote access flow for a browser on another device.

The tunnel only provides reachability. It must not imply trust.

Recommended UX:

- desktop shows a QR code
- desktop also shows a copyable pairing URL
- if the phone opens the host URL without a valid token, the server should render a login or pairing screen rather than granting access

```text
Participants:
  DesktopUser   = user at the host machine
  DesktopMain   = desktop app
  Tunnel        = tunnel provider
  T3Server      = T3 server
  PhoneBrowser  = mobile browser

DesktopUser -> DesktopMain : enable remote access via tunnel
DesktopMain -> T3Server : switch policy to RemoteReachablePolicy
DesktopMain -> Tunnel : publish local T3 endpoint
Tunnel --> DesktopMain : public https/wss URL

DesktopMain -> T3Server : issue one-time pairing token
T3Server --> DesktopMain : pairing token
DesktopMain -> DesktopUser : show QR code / shareable URL

DesktopUser -> PhoneBrowser : scan QR / open URL
PhoneBrowser -> Tunnel : GET https://public-host/pair?token=...
Tunnel -> T3Server : forward request
T3Server -> T3Server : validate one-time token
T3Server -> T3Server : create mobile browser session
T3Server --> PhoneBrowser : Set-Cookie: session=...
T3Server --> PhoneBrowser : redirect to app

PhoneBrowser -> Tunnel : GET /ws + authenticated cookie
Tunnel -> T3Server : forward websocket upgrade
T3Server --> PhoneBrowser : websocket accepted
```

### Phone user with private network

This is operationally similar to the tunnel flow, but the access endpoint is on a private network such as Tailscale.

The auth flow should stay the same.

```text
Participants:
  DesktopUser   = user at the host machine
  T3Server      = T3 server
  PrivateNet    = tailscale / private LAN
  PhoneBrowser  = mobile browser

DesktopUser -> T3Server : enable private-network access
T3Server -> T3Server : switch policy to RemoteReachablePolicy
DesktopUser -> T3Server : issue one-time pairing token
T3Server --> DesktopUser : pairing URL / QR

DesktopUser -> PhoneBrowser : open private-network URL
PhoneBrowser -> PrivateNet : GET http(s)://private-host/pair?token=...
PrivateNet -> T3Server : route request
T3Server -> T3Server : validate one-time token
T3Server -> T3Server : create mobile browser session
T3Server --> PhoneBrowser : Set-Cookie: session=...
T3Server --> PhoneBrowser : redirect to app

PhoneBrowser -> PrivateNet : GET /ws + authenticated cookie
PrivateNet -> T3Server : websocket upgrade
T3Server --> PhoneBrowser : websocket accepted
```

### Desktop user adding new SSH hosts

SSH should be treated as launch and reachability plumbing, not as the long-term auth model.

The desktop app uses SSH to start or reach the remote server, then the renderer pairs against that server using the same bootstrap/session split as every other environment.

```text
Participants:
  DesktopUser   = local desktop user
  DesktopMain   = desktop app
  SSH           = ssh transport/session
  RemoteHost    = remote machine
  RemoteT3      = remote T3 server
  Frontend      = desktop renderer

DesktopUser -> DesktopMain : add SSH host
DesktopMain -> SSH : connect to remote host
SSH -> RemoteHost : probe environment / verify t3 availability
DesktopMain -> SSH : run remote launch command
SSH -> RemoteHost : t3 remote launch --json
RemoteHost -> RemoteT3 : start or reuse server
RemoteT3 --> RemoteHost : port + environment metadata
RemoteHost --> SSH : launch result JSON
SSH --> DesktopMain : remote server details

DesktopMain -> SSH : establish local port forward
SSH --> DesktopMain : localhost:FORWARDED_PORT ready

note over RemoteT3 : policy = RemoteReachablePolicy
note over DesktopMain,RemoteT3 : desktop may use a trusted bootstrap flow here

Frontend -> DesktopMain : request bootstrap for selected environment
DesktopMain --> Frontend : short-lived bootstrap grant

Frontend -> RemoteT3 : POST /api/auth/bootstrap via forwarded port
RemoteT3 -> RemoteT3 : validate bootstrap grant
RemoteT3 -> RemoteT3 : create browser session
RemoteT3 --> Frontend : Set-Cookie: session=...

Frontend -> RemoteT3 : GET /ws + authenticated cookie
RemoteT3 --> Frontend : websocket accepted
```

## Storage decisions

### Server secrets

Use a `ServerSecretStore` abstraction.

Preferred order (use a layer for each, resolve on startup):

1. OS secure storage if available
2. hardened filesystem fallback if not

The filesystem fallback should store only opaque signing material with strict file permissions. It should not store user passwords or reusable third-party credentials.

### Client credentials

Client-side credential persistence should prefer secure storage when available:

- desktop: OS keychain / secure store
- mobile: platform secure storage
- browser: cookie session for browser auth

This concern should stay in the client shell/runtime layer, not the server auth layer.

## What to build now

These are the parts worth building before remote environments ship:

1. `ServerAuth` service boundary.
2. route classification and route guards.
3. `ServerSecretStore` abstraction.
4. bootstrap vs session credential split.
5. browser session cookie codec as one session method.
6. explicit auth capabilities/config surfaced in contracts.

Even if only one pairing flow is used initially, these seams will keep future remote and mobile work contained.

## What to add as part of first remote-capable auth

1. Browser pairing flow using one-time bootstrap token and cookie session.
2. Desktop-managed auto-bootstrap for the local desktop-managed environment.
3. Auth-required defaults for any non-loopback or explicitly published server.
4. Explicit environment auth policy selection instead of scattered `if (host !== localhost)` checks.

## What to defer

- passkeys / WebAuthn
- iCloud Keychain / Face ID-specific UX
- multi-user permissions
- collaboration roles
- OAuth / SSO
- polished session management UI
- complex device approval flows

These can all sit on top of the same bootstrap/session/service split.

## Relationship to future remote environments

Remote access is one reason this auth model matters, but the auth model should not be remote-shaped.

Keep the design focused on:

- one T3 server
- one auth policy
- multiple credential types
- multiple future access methods

That keeps the server auth model stable even as access methods expand later.

## Recommended implementation order

### Phase 1

- Introduce route auth classes.
- Add `ServerAuth` and `AuthRouteGuards`.
- Move existing `authToken` check behind `ServerAuth`.
- Require auth for all privileged HTTP routes as well as WebSocket.

### Phase 2

- Add `ServerSecretStore` service with platform-specific layer implementations.
  - `layerOSXKeychain`, `layer
- Add bootstrap/session split.
- Add browser session cookie support.
- Add one-time bootstrap exchange endpoint.

### Phase 3

- Add desktop bootstrap flow on top of the same services.
- Make desktop-managed local environments default to bootstrap-only pairing.
- Surface auth capabilities in shared contracts and renderer bootstrap.

### Phase 4

- Add non-browser bearer session support if mobile/native needs it.
- Add richer policy modes for remote-reachable environments.

## Acceptance criteria

- No privileged HTTP or WebSocket path bypasses auth policy.
- Local desktop-managed flows still avoid a visible login screen.
- Non-loopback or published environments require explicit authenticated pairing by default.
- Bootstrap and session credentials are distinct in code and in behavior.
- Auth logic is centralized in Effect services/layers rather than route-local branching.
