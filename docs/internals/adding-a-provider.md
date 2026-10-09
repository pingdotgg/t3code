# Adding a provider

A provider integration is judged by whether every T3 feature behaves honestly on it, not by
whether a turn runs. This page lists the decisions and evidence a new driver needs. The
[provider constraints](./providers.md) and the
[capability system](../orchestration-v2/provider-capability-system.md) explain why these rules exist.

## Choose the integration shape

- **ACP agents** start as [ACP Registry](../user/providers-acp.md) entries, which follow the ACP
  spec with no per-agent handling. An agent gets a dedicated driver only when it needs behavior the
  spec does not cover, and then it is a small flavor over the
  [shared ACP adapter](../../packages/provider-acp/src/server/adapter.ts), like Grok
  and Antigravity. Never add agent-id checks to the generic registry adapter.
- **Other protocols** get a native adapter that implements
  [`ProviderAdapterV2`](../../packages/provider-core/src/server/ProviderAdapter.ts), like Codex,
  Claude, Cursor, OpenCode, Pi, and Muse.

Provider-specific behavior stays in the adapter and driver. Orchestration and clients read
capabilities, never the driver kind.

## Report only what the provider does

- **Capabilities.** Set every flag in `OrchestrationV2ProviderCapabilities` to what the provider
  really does. Turn off fork, rollback, steering, or subagent support it lacks; orchestration then
  falls back, for example to portable context handoff for forks. A capability left on that fails
  at runtime is a bug.
- **Permission modes.** Offer only modes the provider enforces natively, through
  `supportedRuntimeModes` in the provider presentation ([Grok](../../packages/provider-grok/src/server/status.ts)
  and [Pi](../../packages/provider-pi/src/server/status.ts) are examples). Do not imitate a missing
  mode by answering approvals in T3: T3's check is weaker than the agent's own enforcement. The
  server runs an unoffered stored mode as Supervised
  ([`RuntimePolicy.ts`](../../apps/server/src/orchestration-v2/RuntimePolicy.ts)).
- **Approval and question options.** Pass the provider's own option IDs through unchanged. Every
  request needs a way to decline that the provider honors.
- **Interaction modes.** Hide the plan toggle (`showInteractionModeToggle: false`) unless the
  provider's plan output becomes T3's proposed-plan card.

## Process, account, and setup boundaries

- **Instances.** Session state, catalogs, and credentials belong to a provider instance, not the
  driver. Remove ambient credentials the instance did not configure, so two instances cannot
  silently share an account or billing.
- **Status checks.** Background status and model refreshes must not open a session that can start
  MCP servers, run hooks, or launch a login. Keep heavier probes behind an explicit refresh.
- **T3 MCP tools.** Inject the thread's MCP server so agents can use T3's tools, and make a turn
  survive when that server is unreachable.
- **Updates.** Run an update only through the installer that provably owns the binary; otherwise
  leave it manual. See [`providerMaintenance.ts`](../../apps/server/src/provider/providerMaintenance.ts).

## Tests

Prove adapter behavior with replay fixtures: a provider transcript replayed through the real
orchestrator, adapter, and projections. See the [testing strategy](../orchestration-v2/testing-strategy.md).

- Record transcripts from the real provider with a recorder script in
  [`apps/server/scripts`](../../apps/server/scripts) (`record-*-replay-fixture.ts`). A new protocol
  usually needs its own recorder.
- Cover the shared scenarios under
  [`testkit/fixtures`](../../apps/server/src/orchestration-v2/testkit/fixtures) that the provider
  supports: `simple`, `multi_turn`, `queued_turn`, `turn_interrupt`, `message_steering`,
  `provider_thread_resume`, and the `tool_call_*` approval cases. Add provider-specific fixtures
  for behavior the shared ones do not reach.
- Unit tests are for pure logic and for failures a real provider cannot produce on demand. A test
  that drives the adapter with hand-written frames is a guess about the protocol; live testing
  regularly finds what those guesses missed.
- A gated live test against the real binary is welcome, but it does not replace replays, because
  CI skips it.

## Traps several providers hit

Each of these broke more than one adapter. A replay fixture for each case your provider can
produce catches them.

- **Settings applied before the provider advertises them.** Agents often list config options after
  the session opens, in a later update, or only once a model runs (an effort option that exists
  only for models with effort). An agent can accept a write before then and change nothing. Wait
  for the option to be advertised before writing it, and treat a stored option the live session
  does not offer as skipped, not as a failure.
- **"Default" is a sentinel, not a model.** A default-model selection must switch the session back
  after a named model ran, including in a resumed session. Never send the sentinel to the
  provider.
- **Stop sent before the turn started.** A cancel that reaches the provider before it registered
  the prompt can be ignored while the turn runs to completion, or can leave a session the provider
  never saved. Find the provider's own turn-started signal, and test a Stop pressed right after
  sending.
- **Work the provider starts on its own.** Background commands, subagents, workflows, and goals can
  finish or start a turn after T3's turn settled. Offer a continuation through
  [`ProviderContinuationRequests`](../../packages/provider-core/src/server/continuationRequests.ts)
  so the parent wakes, and report `hasPendingBackgroundWork` so the session is not released as
  idle. Dropping it, or killing the session, loses the result.
- **Subagents outlive the run that launched them.** A child can report after its parent's turn
  settled, or resume during a later run. Route its updates by the subagent, not by whichever run
  is currently active.
- **A failed or stopped turn leaves nothing open.** Settle the turn's tool calls, subagents, and
  pending approvals and questions. Each terminal path needs its own replay: completion, Stop,
  provider failure, and process exit.
- **Usage limits are not generic failures.** Classify quota and rate-limit errors as `usage_limit`
  with a reset time when the provider gives one, so the thread shows Limited and can resume.
- **Paths and environment.** Test a symlinked workspace, such as macOS `/tmp`; an agent that
  compares canonical paths fails every turn there. Drop inherited credentials the instance did not
  configure. Report unknown sign-in as unknown rather than as signed in.

## Where a driver plugs in

A provider lives in its own `packages/provider-<name>` package, with
[Pi](../../packages/provider-pi) as the reference. Drivers not moved yet still live in
[`provider/Drivers`](../../apps/server/src/provider/Drivers).

- **Package exports.** `./settings` holds the instance settings schema, built with
  `makeProviderSettingsSchema` from contracts. `./client` exports a `ProviderClientDefinition`
  (label, settings schema, plain-data icon, badge) and must stay browser- and React Native-safe.
  `./server` exports the `ProviderDriver` and its adapter driver. `./testing` exposes internals
  the server's replay testkits drive; testkits that need the orchestrator stay in the server.
  Settings live in `providerInstances`; new providers are off by default.
- **Package boundaries.** Server code imports only `@t3tools/provider-core/server/*`, contracts,
  and shared. It reaches the server through `ProviderHost` (paths, settings, background demand,
  attachments, stored credentials), never through `apps/server`. Tests use `@t3tools/provider-testing`.
- **Server registration:** the driver's entry in
  [`builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts) and the adapter driver's in
  [`builtInProviderAdapterDrivers.ts`](../../apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts).
  Also its position in the [status order](../../apps/server/src/provider/providerStatusCache.ts), a
  compatibility policy in [`model-manifest.json`](../../apps/server/src/provider/model-manifest.json)
  (bump `updatedAt`; see [model manifest](./model-manifest.md)), and its default model in contracts.
- **Client registration:** the client definition in the web and mobile provider registries, and
  settings search terms. Clients draw the package icon; do not add a per-driver icon branch.
- **Docs:** a `docs/user/providers-<name>.md` guide in the product's voice, a row in the
  [install](../user/install.md#providers) table, and any provider difference that changes the
  [permission modes](../user/permission-modes.md) page.
