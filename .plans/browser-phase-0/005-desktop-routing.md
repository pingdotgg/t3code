# ADR 005: Retain Renderer Transport Relay Initially

## Status

Accepted for Phase 1; revisit after lifecycle migration.

## Decision

Do not add a second environment-server connection from desktop main solely to remove renderer IPC.

The current renderer-mediated transport can remain temporarily:

```text
environment server -> renderer connection -> typed IPC -> desktop Browser Control Service
```

The renderer must no longer decide browser existence, visible-only eligibility, or ownership. It relays authenticated commands and browser-host events between transports.

## Rationale

Measured renderer IPC overhead was approximately 0.04 ms at the median and approximately 0.20 ms at p95 above direct CDP for a no-op command. That is negligible compared with page work and remote network latency.

The architectural problem is lifecycle coupling and failure ownership, not local IPC performance. A direct desktop-main network connection may still be introduced later for reliability or background operation, but it is not required to begin the durable session migration.

