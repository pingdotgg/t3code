# Desktop Port Forwarding

> The bridge-first manual forwarding slice is implemented. Persistence,
> preview discovery actions, and a native SSH driver remain follow-up work.

## Decision

T3 Code provides environment-scoped local TCP forwarding in the desktop app.

The initial feature maps a loopback listener on the desktop to a loopback TCP
service on one selected remote environment:

```text
development  127.0.0.1:3000 -> desktop 127.0.0.1:43001
primary      127.0.0.1:3000 -> desktop 127.0.0.1:43002
development  127.0.0.1:5432 -> desktop 127.0.0.1:45432
```

It is a private client-side tunnel, not a mechanism for publishing remote
services on the Internet.

## Transport

Do not allocate an additional FRP proxy for each forwarded port. The sovereign
FRP authorization boundary intentionally permits one canonical HTTP proxy per
environment. Expanding it would require public endpoint allocation, lifecycle
reconciliation, and materially broader Internet-facing authorization.

Instead, carry forwarding traffic through the environment's existing
authenticated HTTPS/WSS endpoint:

```text
desktop loopback listener
  -> Electron PortForwardManager
  -> dedicated authenticated binary WebSocket
  -> existing T3 environment endpoint and FRP tunnel
  -> remote T3 TCP bridge
  -> remote loopback service
```

Use one dedicated WebSocket per accepted TCP connection for the first version.
This keeps framing, half-close behavior, cancellation, and backpressure simpler
than a new multiplexing protocol and avoids head-of-line blocking the ordinary
T3 control connection. Multiplex only if measured connection counts justify it.

The server must advertise an additive `tcpPortForwarding` environment
capability. The implementation should remain generic T3 behavior rather than
sovereign-only code:

- T3 Connect environments use the authenticated WebSocket bridge.
- SSH environments may use native `ssh -L` behind the same desktop UI.
- Local environments do not need a tunnel.

## Multi-environment ownership

Electron main owns one process-wide `PortForwardManager`. A forward has a
stable `forwardId` and is scoped internally by `environmentId`, remote host,
and remote port. Display labels are never identity: duplicate environment
labels must remain harmless.

The manager currently owns:

- loopback listeners and atomic port allocation;
- active socket/WebSocket pairs;
- runtime-only definitions;
- account-switch and remote-revocation teardown;
- per-forward and global connection limits.

Persistence, auto-start, waiting/reconnecting states, and creation
deduplication remain part of the next lifecycle-focused slice.

A persisted definition should contain at least:

```ts
interface SavedPortForward {
  readonly forwardId: string;
  readonly environmentId: string;
  readonly remoteHost: "127.0.0.1" | "::1" | "localhost";
  readonly remotePort: number;
  readonly preferredLocalPort: number | null;
  readonly autoStart: boolean;
  readonly label: string | null;
}
```

The assigned local port is device-local runtime state. It should not be synced
through the relay. Bind the real listener atomically; never probe a free port,
release it, and bind later. If a requested port is occupied, report a conflict
or visibly allocate another port—never silently replace an existing mapping.

When an environment is unavailable, retain its saved definition in a waiting
state. Reconcile it when that exact environment ID returns. Removing or
revoking an environment and switching accounts must immediately close its
listeners and all active connections.

## User experience

The desktop Connections settings include a Port forwarding panel with one row
per running definition. The current panel shows:

- environment label plus a short environment-ID fingerprint;
- remote destination and assigned desktop address;
- listener, connecting, connected, and error status;
- connecting and established bridge counts kept separate;
- manual creation and stop actions.

Copy address, open HTTP service, edit, persistence, and richer lifecycle states
remain follow-ups.

The remote server already discovers common loopback development ports. Add a
one-click **Forward to this Mac** action to those results while retaining a
manual TCP-port form. Prefer the same local and remote port when available;
allocate a clear alternate when several environments expose the same port.

HTTP-aware host-header rewriting, friendly `*.localhost` names, and reverse
forwarding are separate follow-ups. The initial primitive remains transparent
TCP, so applications that require a specific HTTP Host or TLS hostname may
need an explicit later HTTP mode.

## Security boundary

The first release must be deliberately narrow:

- TCP only; no UDP.
- Desktop only; web and mobile cannot create operating-system listeners.
- Bind only desktop loopback, never `0.0.0.0` or a LAN address.
- Dial only remote loopback, never arbitrary LAN, container-network, or public
  destinations.
- Authorize each connection with a short-lived, single-use,
  environment-scoped ticket bound to destination and expiration.
- Enforce port validation, bounded buffers, flow control, connection limits,
  idle timeouts, and deterministic half-close/cancellation behavior.
- Log metadata and lifecycle only; never log forwarded bytes or credentials.
- Terminate immediately on sign-out, account switch, environment removal,
  remote revocation, or authorization expiry.

Arbitrary remote destinations would turn an environment into a network pivot.
LAN-visible desktop listeners would expose remote services to the desktop's
network. Both require separate explicit designs and must not arrive as hidden
options in the initial dialog.

## Existing foundations

- `packages/ssh/src/tunnel.ts` already demonstrates loopback allocation,
  tunnel supervision, pending-entry deduplication, readiness, and cleanup.
- The server preview port scanner already finds remote development listeners.
- Contracts and RPC already support streaming operations and byte arrays.
- Environment IDs provide stable multi-remote scoping.
- T3 Connect supplies the authenticated TLS/WSS path.
- Electron already owns IPC validation and local saved-environment state.

The implemented slice includes the authenticated TCP bridge, binary connection
protocol, Electron manager, manual UI, bounded flow control, environment-removal
cleanup, idle timeouts, and connection limits. Persistence and deeper lifecycle
reconciliation remain.

## Delivery order and estimate

1. **Complete:** Contracts, capability, ticket scope, and remote loopback TCP bridge.
2. **Complete:** Dedicated binary WebSocket with bounded flow control and close semantics.
3. **Partial:** Electron manager with atomic listeners and environment-removal cleanup.
4. **Partial:** Runtime-only definitions and manual desktop UI; persistence remains.
5. SSH driver integration behind the same model.
6. Failure-recovery, account-switch, revocation, load, and adversarial tests.

A proof of concept is several focused days. A production-quality TCP feature
with persistence, reconnect behavior, conflict handling, limits, UI, and
security verification is approximately two to four focused engineering weeks.
