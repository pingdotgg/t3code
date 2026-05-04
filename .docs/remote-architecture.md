# Remote Architecture

This document describes the target architecture for first-class remote environments in T3 Code.

It is intentionally architecture-first. It does not define a complete implementation plan or user-facing rollout checklist. The goal is to establish the core model so remote support can be added without another broad rewrite.

## Goals

- Treat remote environments as first-class product primitives, not special cases.
- Support multiple ways to reach the same environment.
- Keep the T3 server as the execution boundary.
- Let desktop, mobile, and web all share the same conceptual model.
- Avoid introducing a local control plane unless product pressure proves it is necessary.

## Non-goals

- Replacing the existing WebSocket server boundary with a custom transport protocol.
- Making SSH the only remote story.
- Syncing provider auth across machines.
- Shipping every access method in the first iteration.

## High-level architecture

T3 already has a clean runtime boundary: the client talks to a T3 server over HTTP/WebSocket, and the server owns orchestration, providers, terminals, git, and filesystem operations.

Remote support should preserve that boundary.

```text
┌──────────────────────────────────────────────┐
│ Client (desktop / mobile / web)             │
│                                              │
│ - known environments                         │
│ - connection manager                         │
│ - environment-aware routing                  │
└───────────────┬──────────────────────────────┘
                │
                │ resolves one access endpoint
                │
┌───────────────▼──────────────────────────────┐
│ Access method                               │
│                                              │
│ - direct ws / wss                           │
│ - tunneled ws / wss                         │
│ - desktop-managed ssh bootstrap + forward   │
└───────────────┬──────────────────────────────┘
                │
                │ connects to one T3 server
                │
┌───────────────▼──────────────────────────────┐
│ Execution environment = one T3 server       │
│                                              │
│ - environment identity                       │
│ - provider state                             │
│ - projects / threads / terminals             │
│ - git / filesystem / process runtime         │
└──────────────────────────────────────────────┘
```

The important decision is that remoteness is expressed at the environment connection layer, not by splitting the T3 runtime itself.

## Domain model

### ExecutionEnvironment

An `ExecutionEnvironment` is one running T3 server instance.

It is the unit that owns:

- provider availability and auth state
- model availability
- projects and threads
- terminal processes
- filesystem access
- git operations
- server settings

It is identified by a stable `environmentId`.

This is the shared cross-client primitive. Desktop, mobile, and web should all reason about the same concept here.

### KnownEnvironment

A `KnownEnvironment` is a client-side saved entry for an environment the client knows how to reach.

It is not server-authored. It is local to a device or client profile.

Examples:

- a saved LAN URL
- a saved public `wss://` endpoint
- a desktop-managed SSH host entry
- a saved tunneled environment

A known environment may or may not know the target `environmentId` before first successful connect.

In the hosted web app, known environments are browser-local. A hosted pairing URL can create the saved entry, but it does not give the hosted app a server-side control plane or a copy of the session state.

### AccessEndpoint

An `AccessEndpoint` is one concrete way to reach a known environment.

This is the key abstraction that keeps SSH from taking over the model.

A single environment may have many endpoints:

- `wss://t3.example.com`
- `ws://10.0.0.25:3773`
- a tunneled relay URL
- a desktop-managed SSH tunnel that resolves to a local forwarded WebSocket URL

The environment stays the same. Only the access path changes.

### AdvertisedEndpoint

An `AdvertisedEndpoint` is a server or desktop-authored candidate endpoint for an environment. It is how the backend tells the client which URLs may be useful for pairing and reconnecting.

`AdvertisedEndpoint` is deliberately narrower than the full access model:

- it describes a concrete HTTP and WebSocket base URL pair
- it can mark the endpoint as default, available, or unavailable
- it includes reachability hints such as loopback, LAN, private, public, or tunnel
- it includes compatibility hints such as whether the endpoint can be used from the hosted HTTPS app

Clients should treat advertised endpoints as hints, not as proof that a route works from the current device. The final connection attempt still decides whether the endpoint is reachable.

The UI presents one default advertised endpoint in the network-access summary and keeps the rest behind an expandable advanced list. The default controls pairing QR codes and primary copy actions. Users can override it, but that override is a UI preference, not backend configuration.

Persist the override by stable endpoint kind rather than raw URL whenever possible. For example, a LAN endpoint should be stored as the desktop LAN endpoint preference, not as `192.168.x.y`, because the address can change when the user switches networks. Provider endpoints should use provider-specific stable keys such as Tailscale IP or Tailscale MagicDNS HTTPS. Custom endpoints may fall back to their concrete identity.

When no user default is saved, endpoint selection should prefer:

1. endpoints compatible with the hosted HTTPS app
2. explicitly default endpoints
3. non-loopback endpoints
4. loopback endpoints only for same-machine clients

This keeps endpoint discovery centralized without making any one provider, such as Tailscale or a future tunnel service, part of the core environment model.

### Endpoint providers

Endpoint providers are add-ons that contribute advertised endpoints for the current environment.

The provider boundary is intentionally outside the core environment model:

- core owns `ExecutionEnvironment`, saved environments, pairing, and connection lifecycle
- providers discover or synthesize endpoints
- providers return normalized `AdvertisedEndpoint` records
- the UI and pairing logic select from those records without knowing provider-specific commands

The first provider is Tailscale. It can discover Tailnet IP and MagicDNS addresses from the local machine and publish them as additional endpoint candidates. Future providers, such as a hosted tunnel service, should plug into the same shape rather than adding a separate remote environment path.

Provider-specific confidence should remain a hint. A Tailscale endpoint still needs a successful browser or desktop connection before the client treats it as connected.

### Hosted pairing request

A hosted pairing request is a bootstrap URL for the static web app, not a transport.

Example:

```text
https://app.t3.codes/pair?host=https://backend.example.com:3773#token=PAIRCODE
```

The hosted app reads the `host` parameter and pairing token, exchanges the token directly with that backend, then saves the resulting environment record in browser local storage.

Important constraints:

- the hosted app does not proxy HTTP or WebSocket traffic
- the backend must still be reachable directly from the browser
- HTTPS pages can only connect to HTTPS/WSS backends
- HTTP LAN endpoints should keep using direct desktop or CLI pairing URLs
- the token belongs in the URL hash so it is not sent to the hosted app origin

### RepositoryIdentity

`RepositoryIdentity` remains a best-effort logical repo grouping mechanism across environments.

It is not used for routing. It is only used for UI grouping and correlation between local and remote clones of the same repository.

### Workspace / Project

The current `Project` model remains environment-local.

That means:

- a local clone and a remote clone are different projects
- they may share a `RepositoryIdentity`
- threads still bind to one project in one environment

## Access methods

Access methods answer one question:

How does the client speak WebSocket to a T3 server?

They do not answer:

- how the server got started
- who manages the server process
- whether the environment is local or remote

### 1. Direct WebSocket access

Examples:

- `ws://10.0.0.15:3773`
- `wss://t3.example.com`

This is the base model and should be the first-class default.

Benefits:

- works for desktop, mobile, and web
- no client-specific process management required
- best fit for hosted or self-managed remote T3 deployments

Browser security rules are part of this access method. A hosted HTTPS web client can connect to `wss://` backends, but it cannot connect to plain `ws://` or `http://` LAN backends because that would be mixed content.

### 2. Tunneled WebSocket access

Examples:

- public relay URLs
- private network relay URLs
- local tunnel products such as pipenet

This is still direct WebSocket access from the client's perspective. The difference is that the route is mediated by a tunnel or relay.

For T3, tunnels are best modeled as another `AccessEndpoint`, not as a different kind of environment.

This is especially useful when:

- the host is behind NAT
- inbound ports are unavailable
- mobile must reach a desktop-hosted environment
- a machine should be reachable without exposing raw LAN or public ports

Tailscale-backed access sits here architecturally even though the current implementation is endpoint discovery rather than a T3-managed tunnel. It contributes private-network endpoints and lets the existing HTTP/WebSocket client path do the actual connection.

### 3. Desktop-managed SSH access

SSH is an access and launch helper, not a separate environment type.

The desktop main process can use SSH to:

- reach a machine
- probe it
- launch or reuse a remote T3 server
- establish a local port forward

After that, the renderer should still connect using an ordinary WebSocket URL against the forwarded local port.

This keeps the renderer transport model consistent with every other access method.

The desktop main process owns the SSH bridge because it can spawn local SSH processes, manage askpass prompts, write temporary launch scripts, and clean up forwards. The renderer receives a saved environment record and connects through the forwarded URL; it should not need SSH-specific RPC paths for normal environment traffic.

## Launch methods

Launch methods answer a different question:

How does a T3 server come to exist on the target machine?

Launch and access should stay separate in the design.

### 1. Pre-existing server

The simplest launch method is no launch at all.

The user or operator already runs T3 on the target machine, and the client connects through a direct or tunneled WebSocket endpoint.

This should be the first remote mode shipped because it validates the environment model with minimal extra machinery.

### 2. Desktop-managed remote launch over SSH

This is the main place where Zed is a useful reference.

Useful ideas to borrow from Zed:

- remote probing
- platform detection
- session directories with pid/log metadata
- reconnect-friendly launcher behavior
- desktop-owned connection UX

What should be different in T3:

- no custom stdio/socket proxy protocol between renderer and remote runtime
- no attempt to make the remote runtime look like an editor transport
- keep the final client-to-server connection as WebSocket

The recommended T3 flow is:

1. Desktop connects over SSH.
2. Desktop probes the remote machine and verifies T3 availability.
3. Desktop launches or reuses a remote T3 server.
4. Desktop establishes local port forwarding.
5. Renderer connects to the forwarded WebSocket endpoint as a normal environment.

The saved environment should remember that it was created by desktop SSH launch only for reconnect and lifecycle UX. That metadata should not change the server protocol or the environment identity model.

Failure handling should be explicit:

- SSH authentication failure should surface before any environment is saved
- remote launch failure should include remote logs or the launcher command output when available
- forwarded-port failure should leave the saved environment disconnected rather than falling back to an unrelated endpoint
- reconnect should attempt to restore the SSH bridge before reconnecting the normal WebSocket client

### 3. Client-managed local publish

This is the inverse of remote launch: a local T3 server is already running, and the client publishes it through a tunnel.

This is useful for:

- exposing a desktop-hosted environment to mobile
- temporary remote access without changing router or firewall settings

This is still a launch concern, not a new environment kind.

## Why access and launch must stay separate

These concerns are easy to conflate, but separating them prevents architectural drift.

Examples:

- A manually hosted T3 server might be reached through direct `wss`.
- The same server might also be reachable through a tunnel.
- An SSH-managed server might be launched over SSH but then reached through forwarded WebSocket.
- A local desktop server might be published through a tunnel for mobile.

In all of those cases, the `ExecutionEnvironment` is the same kind of thing.

Only the launch and access paths differ.

## Security model

Remote support must assume that some environments will be reachable over untrusted networks.

That means:

- remote-capable environments should require explicit authentication
- tunnel exposure should not rely on obscurity
- client-saved endpoints should carry enough auth metadata to reconnect safely

T3 already supports a WebSocket auth token on the server. That should become a first-class part of environment access rather than remaining an incidental query parameter convention.

For publicly reachable environments, authenticated access should be treated as required.

Hosted pairing should be treated as a client-side convenience only. The hosted app must not receive pairing tokens through query parameters, must not store pairing state server-side, and must not imply that an HTTP backend is safe or reachable from an HTTPS browser context.

## Relationship to Zed

Zed is a useful reference implementation for managed remote launch and reconnect behavior.

The relevant lessons are:

- remote bootstrap should be explicit
- reconnect should be first-class
- connection UX belongs in the client shell
- runtime ownership should stay clearly on the remote host

The important mismatch is transport shape.

Zed needs a custom proxy/server protocol because its remote boundary sits below the editor and project runtime.

T3 should not copy that part.

T3 already has the right runtime boundary:

- one T3 server per environment
- ordinary HTTP/WebSocket between client and environment

So T3 should borrow Zed's launch discipline, not its transport protocol.

## Recommended rollout

1. First-class known environments and access endpoints.
2. Direct `ws` / `wss` remote environments.
3. Authenticated tunnel-backed environments.
4. Desktop-managed SSH launch and forwarding.
5. Multi-environment UI improvements after the base runtime path is proven.

This ordering keeps the architecture network-first and transport-agnostic while still leaving room for richer managed remote flows.
