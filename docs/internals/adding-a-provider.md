# Adding a provider

A provider integration is judged by whether every T3 feature behaves honestly on it, not by
whether a turn runs. This page lists the decisions and evidence a new driver needs. The
[provider constraints](./providers.md) and the
[capability system](../orchestration-v2/provider-capability-system.md) explain why these rules exist.

## Choose the integration shape

- **ACP agents** start as [ACP Registry](../user/providers-acp.md) entries, which follow the ACP
  spec with no per-agent handling. An agent gets a dedicated driver only when it needs behavior the
  spec does not cover, and then it is a small flavor over the
  [shared ACP adapter](../../apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts), like Grok
  and Antigravity. Never add agent-id checks to the generic registry adapter.
- **Other protocols** get a native adapter that implements
  [`ProviderAdapterV2`](../../apps/server/src/orchestration-v2/ProviderAdapter.ts), like Codex,
  Claude, Cursor, OpenCode, Pi, and Muse.

Provider-specific behavior stays in the adapter and driver. Orchestration and clients read
capabilities, never the driver kind.

## Report only what the provider does

- **Capabilities.** Set every flag in `OrchestrationV2ProviderCapabilities` to what the provider
  really does. Turn off fork, rollback, steering, or subagent support it lacks; orchestration then
  falls back, for example to portable context handoff for forks. A capability left on that fails
  at runtime is a bug.
- **Permission modes.** Offer only modes the provider enforces natively, through
  `supportedRuntimeModes` in the provider presentation ([Grok](../../apps/server/src/provider/GrokProvider.ts)
  and [Pi](../../apps/server/src/provider/PiProvider.ts) are examples). Do not imitate a missing
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

## Where a driver plugs in

- **Contracts:** settings schema and patch, default model, and display name in
  [`packages/contracts`](../../packages/contracts/src). New providers are off by default.
- **Server:** the driver in [`provider/Drivers`](../../apps/server/src/provider/Drivers) and its entry
  in [`builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts). Also its position in
  the [status order](../../apps/server/src/provider/providerStatusCache.ts), a compatibility policy
  in [`model-manifest.json`](../../apps/server/src/provider/model-manifest.json) (bump `updatedAt`;
  see [model manifest](./model-manifest.md)), and text generation for titles and commit messages.
- **Clients:** web settings metadata and badge, provider icons on web and mobile, and settings
  search terms.
- **Docs:** a `docs/user/providers-<name>.md` guide in the product's voice, a row in the
  [install](../user/install.md#providers) table, and any provider difference that changes the
  [permission modes](../user/permission-modes.md) page.
