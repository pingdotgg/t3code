# Remote Endpoints and Hosted Static App Plan

## Purpose

Make remote access feel first-class while keeping the free DIY path open.

The immediate product goal is:

- users can expose a backend through LAN, their own Tailscale, MagicDNS, a manual HTTPS endpoint, or later T3 Tunnel
- users can generate a hosted pairing link for `app.t3.codes`
- the hosted app can pair, persist, reconnect, and operate against saved environments without requiring a backend at the hosted app origin
- all transports reuse the same backend auth, WebSocket runtime, saved environment registry, and pairing UX

This plan intentionally leaves the paid T3 cloud tunnel fabric out of scope. It defines the OSS foundation that T3 Tunnel should later plug into.

## Current State

Already present or in progress:

- Server auth distinguishes bootstrap credentials from session credentials.
- One-time pairing credentials can be exchanged for browser sessions or bearer sessions.
- Saved remote environments store `httpBaseUrl`, `wsBaseUrl`, and a bearer token.
- Remote environment WebSocket connections use a short-lived WebSocket token.
- Pairing URLs can carry tokens in the URL fragment.
- Hosted `/pair?host=...#token=...` can add a saved environment.
- Hosted static startup can avoid assuming the page origin is the backend.

Main gaps:

- Reachability is represented ad hoc as `endpointUrl`, manual host input, or saved environment URLs.
- Desktop exposure, hosted pairing, manual remote environments, and future tunnels do not share one endpoint model.
- Tailscale/MagicDNS endpoints are not detected or surfaced.
- Hosted-static empty/offline states are still thin.
- Browser compatibility is not explicitly modeled, especially HTTPS hosted app to HTTP backend mixed-content failure.

## Core Decision: Add `AdvertisedEndpoint`

Add a new first-class contract instead of extending the environment descriptor.

### Why not extend `ExecutionEnvironmentDescriptor`

`ExecutionEnvironmentDescriptor` answers: "What environment is this?"

Examples:

- environment id
- label
- platform
- server version
- capabilities

`AdvertisedEndpoint` answers: "How can a client reach this environment right now?"

Examples:

- loopback URL
- LAN URL
- Tailscale IP URL
- MagicDNS/Serve URL
- manual URL
- future T3 Tunnel URL
- browser compatibility and exposure level

Those are different lifecycles. One environment can have many endpoints, endpoints can appear/disappear as network interfaces change, and the same descriptor is returned regardless of which endpoint the client used. Extending the descriptor would blur environment identity with transport reachability and make saved environments harder to reason about.

### Target Contract

Add a schema in `packages/contracts`, likely `remoteAccess.ts`:

```ts
type AdvertisedEndpointProvider =
  | "loopback"
  | "lan"
  | "tailscale-ip"
  | "tailscale-magicdns"
  | "manual"
  | "t3-tunnel";

type AdvertisedEndpointVisibility = "local" | "private-network" | "tailnet" | "public";

type AdvertisedEndpointCompatibility = {
  hostedHttpsApp: "compatible" | "mixed-content-blocked" | "untrusted-certificate" | "unknown";
  desktopApp: "compatible" | "unknown";
};

type AdvertisedEndpoint = {
  id: string;
  provider: AdvertisedEndpointProvider;
  label: string;
  httpBaseUrl: string;
  wsBaseUrl: string;
  visibility: AdvertisedEndpointVisibility;
  compatibility: AdvertisedEndpointCompatibility;
  source: "server" | "desktop" | "user";
  status: "available" | "unavailable" | "unknown";
  isDefault?: boolean;
};
```

Keep the contract schema-only. All classification logic belongs in `packages/shared`, `apps/server`, `apps/desktop`, or `apps/web`.

## HTTP/WS and HTTPS/WSS Readiness

The codebase is partially ready, but the UX and compatibility model are not explicit enough.

What is ready:

- Remote target parsing already derives `ws://` from `http://` and `wss://` from `https://`.
- Saved environments store both HTTP and WebSocket base URLs.
- Remote auth uses bearer tokens instead of cookies, so cross-origin hosted clients are viable.
- WebSocket connections can use a dynamically issued `wsToken`.
- Server CORS support exists for browser remote auth endpoints.

What is not solved by code alone:

- `https://app.t3.codes` cannot reliably call `http://...` or `ws://...` endpoints because browsers block mixed content.
- `wss://100.x.y.z:3773` needs a certificate the browser trusts. A raw Tailscale IP does not solve certificate trust.
- LAN `http://192.168.x.y:3773` is usable from another desktop/native context but not from the hosted HTTPS app.
- The UI needs to explain why an endpoint is copyable for desktop pairing but not hosted-app compatible.

Policy:

- Support both HTTP/WS and HTTPS/WSS at the runtime layer.
- Mark endpoint compatibility at the product layer.
- Generate `app.t3.codes` links only from endpoints that are likely hosted-browser compatible, or show a warning with an explicit fallback.

## Architecture

### Endpoint Sources

Endpoint records can come from several providers:

1. **Server runtime**
   - headless bind host and port
   - server-known explicit advertised host config

2. **Desktop shell**
   - loopback backend URL
   - LAN exposure state
   - network interface discovery
   - Tailscale CLI/status discovery

3. **User configuration**
   - manually added hostnames
   - preferred endpoint labels
   - hidden/disabled endpoints

4. **Future cloud provider**
   - T3 Tunnel endpoint
   - billing/account status
   - tunnel lifecycle state

### Endpoint Registry

Create a central runtime registry:

- `packages/contracts/src/remoteAccess.ts`
- `packages/shared/src/remoteAccess.ts` for URL normalization and compatibility classification
- `apps/server/src/remoteAccess/*` for server/headless endpoints
- `apps/desktop/src/remoteAccess/*` for desktop-discovered endpoints
- `apps/web/src/environments/endpoints/*` for client-side display and pairing selection

The web app should consume endpoint records and not care whether they came from LAN, Tailscale, or a future tunnel.

### Pairing Link Generation

Move hosted pairing link generation to endpoint-driven input:

```ts
buildHostedPairingUrl({
  endpoint: AdvertisedEndpoint,
  token,
});
```

Generated URL:

```text
https://app.t3.codes/pair?host=<encoded endpoint httpBaseUrl>#token=<one-time token>
```

Use fragment tokens by default. Continue accepting `?token=` for compatibility.

## Phase 1: Endpoint Abstraction

### Goals

- Centralize URL normalization, protocol derivation, and compatibility checks.
- Replace ad hoc desktop `endpointUrl` pairing logic with endpoint selection.
- Preserve all current remote behavior.

### Tasks

1. Add `AdvertisedEndpoint` schemas to `packages/contracts`.
2. Add shared helpers:
   - normalize HTTP base URL
   - derive WebSocket base URL
   - classify loopback/private/LAN/Tailscale/public host
   - classify hosted HTTPS compatibility
3. Add server endpoint discovery:
   - loopback endpoint
   - configured non-loopback endpoint
   - explicit advertised host override
4. Add desktop endpoint discovery:
   - local loopback
   - LAN exposure endpoint
   - endpoint status labels
5. Add WebSocket/API method or existing config field for endpoint snapshots.
6. Refactor settings connections UI:
   - render endpoint rows
   - endpoint picker for pairing link copy
   - show compatibility warnings
7. Refactor hosted link builder to accept endpoint records.
8. Add tests for URL normalization and compatibility classification.

### Acceptance Criteria

- Existing LAN/network access UI still works.
- Pairing links are generated from endpoint records.
- Loopback endpoints never produce hosted pairing links silently.
- HTTP private-network endpoints are marked incompatible with `app.t3.codes`.
- No remote environment runtime changes are required for existing saved environments.

## Phase 2: BYO Tailscale/MagicDNS

### Goals

- Detect free DIY Tailscale reachability.
- Surface Tailscale endpoints as normal advertised endpoints.
- Keep users in control of their own tailnet.

### Tasks

1. Detect Tailscale IPs from network interfaces:
   - IPv4 `100.64.0.0/10`
   - mark as `provider: "tailscale-ip"`
2. Add optional desktop-side `tailscale status --json` discovery:
   - MagicDNS hostname
   - Tailscale Serve/Funnel HTTPS endpoint if discoverable
   - graceful failure if CLI is missing
3. Add manual Tailscale endpoint override:
   - hostname
   - label
   - preferred/default flag
4. Show Tailscale endpoint rows in settings:
   - raw IP HTTP endpoint: desktop-compatible, hosted-app likely blocked
   - HTTPS MagicDNS/Serve endpoint: hosted-compatible if URL is HTTPS
5. Generate pairing links using selected Tailscale endpoint.
6. Document DIY setup:
   - local desktop-to-desktop over Tailscale
   - hosted app requirements
   - why HTTPS matters

### Acceptance Criteria

- A machine on Tailscale shows a Tailscale endpoint without paid features.
- Users can copy a Tailscale-hosted pairing link when the endpoint is HTTPS-compatible.
- Users can still copy token-only/manual values when endpoint compatibility is unknown.
- Tailscale is optional and never required for regular LAN/loopback use.

## Phase 3: Hosted Static App Completion

### Goals

- `app.t3.codes` works as a real client shell.
- It can pair, persist, reconnect, and clearly explain offline/incompatible states.

### Tasks

1. Finish hosted-static root behavior:
   - no primary backend required
   - saved environment hydration before initial routing decisions
   - first saved environment selected as active
2. Add hosted empty state:
   - no saved environments
   - paste pairing URL
   - add host + token
3. Add offline saved environment UI:
   - last connected
   - reconnect
   - remove
   - copy/add alternate endpoint
4. Audit primary-backend assumptions:
   - command palette
   - settings pages
   - server config atom defaults
   - keybindings
   - provider/model lists
   - update/desktop-only affordances
5. Add route tests for:
   - hosted `/pair?host=...#token=...`
   - hosted root with no saved environments
   - hosted root with saved environment
   - primary backend unavailable but saved environment present
6. Add deployment hardening:
   - SPA fallback
   - strict CSP
   - no third-party scripts
   - no query token logging
   - disable or hide source maps in production if needed
7. Add browser error messages:
   - mixed content
   - unreachable backend
   - CORS failure
   - certificate failure

### Acceptance Criteria

- `app.t3.codes` can pair a reachable HTTPS backend and reconnect after reload.
- A saved environment can be used without any backend at `app.t3.codes`.
- Offline machines show a useful state instead of a generic boot error.
- HTTP endpoints are still supported in desktop/native/local contexts.
- Hosted HTTPS app only promises compatibility for HTTPS/WSS endpoints.

## Phase 4: Future T3 Tunnel Provider

Not part of the current implementation, but the endpoint abstraction should make it straightforward.

Future tunnel provider responsibilities:

- create endpoint with `provider: "t3-tunnel"`
- surface tunnel status
- provide stable HTTPS URL
- use existing backend pairing/session auth
- never bypass server auth

The tunnel fabric can later be Pipenet-derived, Tailscale-derived, or another reverse tunnel implementation. The rest of T3 Code should only see an `AdvertisedEndpoint`.

## Security Checklist

- Pairing tokens are short-lived and one-time.
- Generated hosted pairing links put tokens in the fragment.
- The backend remains the authorization boundary.
- Endpoint discovery never disables backend auth.
- Hosted app does not silently downgrade to HTTP.
- Tunnel/public endpoints require explicit user action.
- Client sessions remain revocable.
- Endpoint URLs and request logs must avoid recording pairing tokens.
- Future cloud tunnel must authenticate tunnel creation and tunnel data connections separately from backend pairing.

## Verification

Each implementation PR should run:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- focused tests for changed backend/web behavior
- backend tests for any server-side endpoint discovery or auth changes using `bun run test`, never `bun test`

