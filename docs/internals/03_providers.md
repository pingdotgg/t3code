# Providers

Provider protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../packages/provider-core/src/server/ProviderAdapter.ts). Orchestration and
clients read declared capabilities, never provider names.

## Identity and integration shape

- **App IDs are primary; provider IDs are refs.** Never match native provider IDs globally without
  provider/session/thread scope, and never let child provider turn completions close a parent run.
- **Route by provider instance, not driver kind.** Session state, catalogs, and credentials belong
  to a provider instance so two accounts on the same driver cannot share mutable state. Strip
  ambient credentials the instance did not configure.
- **Strict ACP compliance for non-first-party agents.** Generic
  [ACP Registry](../user/providers-acp.md) and local ACP commands follow the ACP specification
  strictly—never deviate from the spec or add agent-id checks, vendor extensions, or
  driver-specific workarounds in the shared ACP adapter for non-first-party agents. If an upstream
  ACP agent deviates from or lacks part of the spec, let orchestration degrade through capabilities
  rather than special-casing it here. Dedicated ACP flavors (over `packages/provider-acp`) are
  reserved for first-party drivers that need behavior outside the ACP spec; native
  `ProviderAdapterV2` adapters are only for non-ACP protocols.
- **Package boundaries.** Providers live in `packages/provider-<name>` (see
  [Pi](../../packages/provider-pi) as reference). Server code imports only
  `@t3tools/provider-core/server/*`, contracts, and shared, reaching host capabilities through
  `ProviderHost` rather than `apps/server`. Client definitions (`./client`) must stay browser- and
  React Native-safe.

## Honest capabilities and permissions

- **Declare only what the provider actually supports.** Turn off fork, rollback, steering, or
  subagent capabilities the provider lacks so orchestration degrades cleanly (for example, portable
  context handoff for forks). A capability left enabled that fails at runtime is a bug.
- **Never emulate missing permission modes.** Expose only modes the provider enforces natively; do
  not fake a mode by auto-answering approvals in T3. Unoffered stored modes fall back to Supervised.
  Pass native approval and question option IDs through unchanged, and ensure every request can be
  declined.
- **Hide plan mode unless it produces proposed-plan cards.**
- **Startup phases come from real signals.** An adapter reports the step a starting turn is on as
  `startupPhase` on its provider session, and only when the protocol says so: a notification or an
  awaited request with one meaning, never a timer. Clear it the moment the provider can be doing
  something else. Clients show it until the run's first output. A session that serves several
  threads names the one it describes with `startupPhaseThreadId`.
  Nothing an adapter emits during `openSession` is visible, because the session is not attached yet.
  Turn start republishes `runtime.providerSession`, so a phase that spans it must be on that record.
- **Reject conversation rollback before touching files** when the provider cannot roll back its
  conversation (see [checkpoints](./01_architecture.md#turn-completion-and-checkpoints)).

## Process, setup, and security boundaries

- **Health checks must stay passive.** Background status and model probes must never open a session
  that starts MCP servers, runs hooks, or launches a login flow. Reserve heavier probes for explicit
  refresh or setup.
- **Updates run only through a provably owning installer.** Prove ownership from the resolved
  executable path (or use a self-updater that checks its own install); leave ambiguous, pinned, or
  read-only installs (such as Nix) manual-only.
- **Attachments stay outside the project workspace.** Never copy uploads into the project tree to
  bypass a provider's sandbox or approval rules.
- **T3 MCP tools.** Inject the thread's authenticated MCP server so agents can reach T3 tools, and
  keep turns working if that server is unreachable.

## Model manifest

The bundled [`model-manifest.json`](../../apps/server/src/provider/model-manifest.json) enables
offline startup while remote fetches from `main` update metadata between releases. A bundled
manifest outranks the cached remote copy by `updatedAt`, so **bump `updatedAt` on every edit**.
Declare broken-version minimums in the manifest policy rather than as driver constants. Test catalog
and adapter semantics with synthetic model names so adding a model never requires duplicating config
in tests.

## Cross-provider traps and testing

Prove adapter behavior with replay fixtures recorded from the real provider and replayed through the
real orchestrator, adapter, and projections. Hand-written protocol frames guess at wire behavior; use
unit tests for pure logic and failure paths a real provider cannot trigger on demand.

Traps that have broken multiple adapters:

- **Lazy config advertisement.** Providers often advertise options only after a session opens or a
  model runs. Wait for advertisement before applying settings, and skip unoffered stored options
  rather than failing.
- **`"Default"` is a sentinel, not a model ID.** Never send it to a provider; clear or reset the
  session's model selection instead.
- **Early Stop.** Cancelling before the provider registers the prompt can be ignored or strand a
  session. Gate cancellation on the provider's turn-started signal.
- **Work outliving a turn.** Background tasks, subagents, and provider-initiated continuations can
  report after T3's turn settles. Route subagent updates by subagent (not active run), request
  continuations when needed, and report pending background work so idle cleanup does not kill the
  session.
- **Terminal settlement.** Every terminal path (completion, Stop, provider error, process exit) must
  settle open tool calls, subagents, and pending requests.
- **Usage limits.** Classify quota/rate-limit errors as `usage_limit` (with reset time when
  available) rather than generic failures.
- **Symlinked workspaces.** Test symlinked paths (such as macOS `/tmp`); providers that compare
  canonical paths break if cwd handling disagrees.
