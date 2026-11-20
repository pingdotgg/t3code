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
  parsing and the SDK 0.1.7 adapter (`connectOpenShellGateway`).
- `src/sandboxPolicy.ts` — runtime-mode → T3 sandbox policy translation
  (spec section 5.2), valid at the `RuntimePolicy.sandboxPolicy` seam. Its
  translation to OpenShell's Landlock/network policy schema is still open.

## OPEN items

- `@nvidia/openshell-sdk@0.1.7` is vendored as a locally built npm tarball
  (`vendor/nvidia-openshell-sdk-0.1.7.tgz`) from public source tag
  `v0.1.7` (`5d25211b25a8fc887e8d5c606d57d6ab22f1d76c`), avoiding the
  GitHub Packages credential while keeping the exact release provenance.
  Replace it with the registry artifact when a `read:packages` credential is
  available. Raw SDK RPCs bridge curated seams that omit durable request ids
  and per-sandbox environment overrides.
- Mapping `sandboxPolicyForRuntimeMode` to OpenShell's policy message is
  unresolved; the real adapter currently does not send that value.
- SDK 0.1.7 rejects per-sandbox environment overrides on a template create.
  The adapter therefore refuses shared-cache spawn seeds instead of sending an
  invalid request; seeding needs a supported template/bootstrap mechanism.
- Pairing pickup command (`t3 pairing print`) is fixed with the t3-agent
  image in P1 (spec section 4.4).
- Conservative spawn policy default (`approval-required`) — see
  `src/sandboxPolicy.ts`; whether the delegating thread's mode should be
  inherited is undecided.
- Idle-TTL dial (spec section 5.6) needs worker activity heartbeats; v1
  enforces the hard lifetime only, and `idleTimeoutMs`/`resources` in worker
  defaults are accepted but unused.
- Worker baggage (`workerBaggage.ts`) builds the copy/mount plan but is not
  executed by provisioning yet: provider config homes and project instructions
  are not copied into a sandbox in this PR.
- An `openshell.credential` reference is stored but not resolved; the gateway
  reads the `openshell-gateway-credential` server secret.
