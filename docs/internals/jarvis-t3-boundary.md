# Jarvis–T3 boundary

> For maintainers. This is the maintenance boundary for Jarvis changes and upstream rebases.

Jarvis is a product layer over the T3 harness. This boundary exists to make upstream T3 changes
safe to absorb, not to make this fork ship two independently supported products. Jarvis product
packages and adapters may depend on stable T3 seams; high-churn T3 internals should remain unaware
of Jarvis concepts wherever that materially reduces rebase conflicts.

```text
Jarvis UI / mesh / task desk / voice
            │
            ▼
Jarvis adapters and product packages
            │  public seams only
            ▼
T3 contracts, client runtime, provider/session/Git/terminal/approval services
```

## Product composition

Jarvis is one product composition over the T3 harness. Full, Controller, Headless, and the
optional standalone Companion are capability-specific Jarvis surfaces and runtimes; a release has
no requirement to ship or boot a second independently bootable pure-T3 product beside Jarvis.
Companion is a separately packaged Jarvis speech/control surface, not a second T3 product or an
execution host.

Ordinary T3 harness behavior remains intact for normal T3 flows. The seams exist to keep the Jarvis
layer rebaseable onto that harness, not to create a parallel product boundary or move generic
provider, session, Git, terminal, or approval ownership into Jarvis.

There is no acceptance requirement to build or boot a separate upstream-branded T3 application
from this fork. The requirement is that the T3 coding-harness behavior Jarvis uses keeps working
after an upstream merge: providers, sessions, Git, terminals, approvals, and the detailed coding
UI. Jarvis is the composition we ship and test.

## The rebase invariant

T3 provider, session, Git, terminal, and approval internals do not import or name nodes, the mesh,
voice, task desk, Jarvis UI, or other Jarvis product concepts. They expose generic capabilities and
typed events. Jarvis supplies product policy at the composition boundary and translates those
capabilities into Jarvis behavior.

The reverse dependency is intentional: Jarvis may use a public T3 contract or service. Avoid adding
Jarvis callbacks, fields, imports, or special cases inside provider/session/Git/terminal/approval
implementations because those are upstream-owned, high-conflict areas. Named, shallow changes at a
composition root, contract registry, build entrypoint, or branding hook are acceptable when they
are the smallest honest integration point.

## Current ownership

- `packages/jarvis-client-runtime` owns Jarvis client state and mesh-facing adapters. It consumes
  public RPC, authorization, connection, and environment seams; Jarvis-capable web and desktop
  surfaces compose it with their UI and platform layers. Mobile does not currently consume this
  Jarvis runtime.
- `packages/jarvis-core` owns provider-neutral Jarvis decisions and vocabulary: task intent,
  request identity, project targeting, and reports. It has no provider process, filesystem, Git, or
  UI authority.
- `packages/jarvis-native-voice` owns the local Parakeet/Pocket speech runtime and its isolated
  worker seam. The stabilized Full GUI capture path is the exact shared `node-cpal` `0.1.1`
  implementation on Windows/Linux x64; the product-owned Rust microphone path is no longer a
  production boundary. These are product capabilities, not dependencies of generic T3 provider or
  terminal code. Full's `uiohook` hold-to-talk and Electron tap fallback remain desktop composition
  concerns. Headless has no voice capability, and macOS microphone support is deferred without a
  release claim.
- `apps/server/src/jarvis/` owns the server-side Jarvis adapters and composition. The generic
  `ProviderExecutionPolicy` service lives under the T3 provider services; the Jarvis implementation
  is a layer that supplies policy through that generic interface. Jarvis HTTP endpoints are a
  separate `EnvironmentJarvisHttpApi` group implemented by `apps/server/src/jarvis/http.ts`; the
  generic orchestration HTTP group owns only snapshots, thread detail, and dispatch. Jarvis result
  delivery is likewise owned by `JarvisCompletionReactor`: it consumes generic orchestration events
  through the public engine/projection seams and emits Jarvis completion activity. The generic
  `CheckpointReactor` owns only VCS checkpoint and diff lifecycle work; it neither imports nor
  recognizes Jarvis activities.
- `packages/contracts` is the central wire seam. Shared contracts may mention the product boundary
  when a message is intentionally public, but the implementation behind a generic T3 contract must
  remain product-neutral.
- `ExecutionEnvironmentCapabilities.jarvisNode` and `jarvisReportInbox` are intentional public
  capability markers in `packages/contracts`. They let clients discover Jarvis capability through
  the typed environment descriptor instead of adding probe endpoints or inferring support from
  failures; they do not move Jarvis behavior into generic T3 services.
- Jarvis preset parsing and fields in `apps/server/src/cli/config.ts`, `apps/server/src/config.ts`,
  and `apps/server/src/environment/ServerEnvironment.ts` are intentional startup plumbing. The
  server must advertise the capability selected by a packaged node, and keeping that selection in
  the central typed configuration/environment path is smaller and more honest than a parallel
  discovery mechanism.
- These exceptions are accepted because central typed discovery and shallow composition are smaller
  and more honest than probe endpoints, extension bags, or generic callback frameworks: clients need
  a typed capability marker and packaged nodes need startup selection, while product behavior stays
  in Jarvis adapters and composition roots.
- `apps/server/src/persistence/Migrations.ts` is a historical shared-registry exception: Jarvis
  migrations 41–46 have shipped, and upstream migration 47 was appended after them. Those IDs are
  immutable; future rebases must resolve the shared migration sequence deliberately.

## Permitted seams

These are the preferred places to connect the two layers:

1. Central typed contracts in `packages/contracts`.
2. Public T3 service interfaces and adapters, such as provider execution, session, environment,
   Git, terminal, and approval capabilities.
3. Top-level product composition in the server, web, or desktop entrypoint, where a Jarvis layer is
   provided to a generic T3 layer or a generic result is adapted for Jarvis.
4. Shallow build and branding entrypoints that select the Jarvis product composition or package its
   capabilities for a target surface.

Outside the documented capability markers and startup plumbing, do not add Jarvis imports to T3
provider/session/Git/terminal/approval implementations, add Jarvis fields to generic domain models,
or route around the public seam with a direct reach into another layer's internals. Server, web,
desktop, build, and branding patches are acceptable only when they are shallow composition changes.
If a seam is missing, choose the option with the smaller long-term upstream conflict surface: either
a narrow generic interface that has a real T3 meaning, or one explicit Jarvis composition patch.
Do not invent probe endpoints, extension bags, or generic callback frameworks for a single Jarvis
caller.

This is a conflict-budget rule, not a purity rule. A direct edit to a stable composition, discovery,
build, or branding file can be cheaper and clearer than another package or callback. Conversely,
Jarvis product logic does not belong in an upstream-owned implementation merely because placing it
there saves a file today.

## Rebase and migration order

Keep upstream integration sequenced so the boundary remains reviewable:

1. Rebase or merge the T3 foundation first: contracts, generic services, orchestration, and shared
   client runtime. Preserve the documented capability markers and central discovery seams, while
   keeping Jarvis names out of provider/session/Git/terminal/approval implementations and unrelated
   high-churn internals.
2. Reapply or port the extracted Jarvis packages (`jarvis-client-runtime`, `jarvis-core`, and the
   native voice package) as product-owned changes. Do not restore the retired Rust microphone path
   as a production dependency.
3. Reconnect `apps/server/src/jarvis/` through the generic T3 seams and top-level composition. Keep
   provider-specific behavior in the Jarvis adapter, never in the generic provider service.
4. Reconcile client and UI integrations after the contracts and server adapters agree. Do not make a
   UI conflict the reason to widen a server-internal dependency.
5. Run ownership/dependency checks and focused Jarvis plus upstream-harness tests before resolving
   unrelated conflicts. A rebase is complete when the dependency direction is unchanged, the
   named integration patches remain shallow, and the T3 behaviors Jarvis relies on still work. A
   standalone pure-T3 build from this fork is not part of that gate.

For the broader workspace map, see [workspace layout](./workspace-layout.md). The existing request
and report flows are described in [Jarvis manager](./jarvis-manager.md).
