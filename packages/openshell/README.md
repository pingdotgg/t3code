# @t3tools/openshell

OpenShell fleet driver (spec section 12): sandbox lifecycle over the gateway,
template selection, pairing handoff into the phase-2
`PeerEnvironmentRegistry`, drain-first removal, orphan sweep and ephemeral-TTL
enforcement. The registry, drain data plane, pairing protocol and audit stay
t3-native.

## Layout

- `src/OpenShellGatewayDriver.ts` — the driver implementing the contracts
  `GatewayDriver` interface plus `createSandboxFromTemplate`, `enforceTtl` and
  `orphanSweep`. Collaborators are injected:
  - `OpenShellGatewayClient` — gateway transport (below).
  - `WorkerPairingRegistrar` — Promise-shaped mirror of the phase-2
    `PeerEnvironmentRegistry` `register`/`exchangeBootstrap`; `apps/server`
    adapts the Effect service directly, the inputs already match.
  - `FleetDrainExecutor` — the section 7 drain protocol adapter (threads,
    worktrees, acks); without it removal refuses.
  - `FleetWorkerIndex` — Promise-shaped mirror of the phase-2
    `OpenShellFleetStore`; the default is in-memory, servers inject the
    sqlite store so state survives restarts.
- `src/gatewayClient.ts` — structural client interface, pairing-material
  parsing and the real-SDK adapter (`connectOpenShellGateway`).
- `src/sandboxPolicy.ts` — runtime-mode → sandbox policy translation
  (spec section 5.2), valid at the `RuntimePolicy.sandboxPolicy` seam and
  applied as gateway per-sandbox policy at spawn.

## OPEN items

- `@nvidia/openshell-sdk` ships via GitHub Packages only (lane 1); this
  checkout cannot authenticate, so the dependency is intentionally absent and
  the adapter imports it lazily. Pin `0.1.7` when the registry credential
  exists — see `src/gatewayClient.ts`.
- Pairing pickup command (`t3 pairing print`) is fixed with the t3-agent
  image in P1 (spec section 4.4).
- Conservative spawn policy default (`approval-required`) — see
  `src/sandboxPolicy.ts`; whether the delegating thread's mode should be
  inherited is undecided.
- Idle-TTL dial (spec section 5.6) needs worker activity heartbeats; v1
  enforces the hard lifetime only.
