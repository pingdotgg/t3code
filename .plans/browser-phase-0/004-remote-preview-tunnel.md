# ADR 004: Raw TCP Preview Tunnel

## Status

Transport accepted; desktop ingress and authorization amended by `.plans/browser-phase-0-5/009-loopback-threat-model.md`.

## Decision

Remote environment ports are exposed to the desktop browser through:

```text
browser webview
  -> browser-attributed stable desktop authority
  -> dedicated authenticated WebSocket tunnel
  -> environment server tunnel endpoint
  -> environment loopback TCP target
```

Multiplex TCP streams over a bounded number of dedicated authenticated tunnel connections before relay rollout. The protocol must preserve backpressure, half-close, cancellation, and connection-specific errors.

The browser navigates to a stable desktop authority, preserving normal origin and root-relative URL behavior. A bare loopback listener is not an authorization boundary, and absolute redirects, OAuth callbacks, and HTTPS upstreams require explicit policy.

## Isolation

Tunnel data uses a dedicated connection and priority class. It must not share the normal RPC/event WebSocket because large responses or stalled browser streams must not delay thread control traffic.

## Authorization

Each listener is backed by a short-lived grant scoped to:

- environment
- browser session
- target loopback host
- target port
- protocol policy
- provider/thread authorization where agent-created

The environment server validates the grant before opening any TCP target.
