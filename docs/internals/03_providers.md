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
  `@lathe/provider-core/server/*`, contracts, and shared, reaching host capabilities through
  `ProviderHost` rather than `apps/server`. Client definitions (`./client`) must stay browser- and
  React Native-safe.

## Choose the integration shape

The generic ACP integration excludes per-agent branches, private vendor RPC or HTTP calls, and
readers for a vendor CLI's credentials or history. A dedicated driver requires a maintainer's
explicit decision to own that integration. Existing exceptions establish no precedent.

Decline workarounds for agents that violate the ACP spec and ask the author to file an issue with
the agent's maintainer, including a minimal protocol transcript and the relevant spec section.
Missing portable capabilities belong upstream in ACP. Vendor-neutral primitives, including shared
ACP text generation and user-hosted HTTP quota sources, are welcome.

A misleading permission guarantee in Lathe is a Lathe bug. Correct the shared behavior so the capability
and permission claims match what the protocol can enforce.

## Honest capabilities and permissions

- **Declare only what the provider actually supports.** Turn off fork, rollback, steering, or
  subagent capabilities the provider lacks so orchestration degrades cleanly (for example, portable
  context handoff for forks). A capability left enabled that fails at runtime is a bug.
- **Never emulate missing permission modes.** Expose only modes the provider enforces natively; do
  not fake a mode by auto-answering approvals in Lathe. Unoffered stored modes fall back to Supervised.
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
- **Lathe MCP tools.** Inject the thread's authenticated MCP server so agents can reach Lathe tools, and
  keep turns working if that server is unreachable.
- **Thread history follows the project setting on every call.** MCP credentials stay scoped to one
  thread, but the `thread-history` capability lets that thread read other threads under the
  project's `agentThreadHistoryAccess` level. The level governs these tools, not a sandbox: agents
  with shell access on the host can still read local state directly. The capability is granted
  when the [session manager](../../apps/server/src/orchestration-v2/ProviderSessionManager.ts)
  issues the thread's credential (see
  [ForkAgentAccess](../../apps/server/src/orchestration-v2/fork/ForkAgentAccess.ts)), while the
  [handlers](../../apps/server/src/mcp/toolkits/threadHistory/handlers.ts) re-resolve the level on
  every call, so lowering it applies to the next call and a running session never reads more than
  the current setting allows. Raising it from `off` takes effect only in a new session, since that
  is the only point where the capability is added. Threads the user referenced in the caller's own
  messages are readable at every level except `off`; see the
  [scope rules](../../apps/server/src/mcp/toolkits/threadHistory/scope.ts). The
  [digest](../../apps/server/src/mcp/toolkits/threadHistory/digest.ts) is built deterministically
  from the projection with no model in the loop, so it is identical across providers and can be
  pinned by tests.

## Browser sign-in is relayed through the client

A sign-in started on the environment prints an authorization URL and waits on a loopback listener
that the user's browser, on another machine, never reaches. The
[auth relay](../../apps/server/src/auth-relay/AuthRelayFlow.ts) closes that gap for every
provider the same way: capture the URL on the environment, show it only to the Lathe auth session that
started the flow, carry the return URL back from that session, and replay it against the listener
on the environment. Drivers supply how to obtain the URL, how to recognize their own callback, and
how to sign out; the flow owns ownership, single flight, the deadline, and cancellation.

Tools that open the page themselves are caught through the
[`BROWSER` hijack](../../apps/server/src/auth-relay/browserLaunchCapture.ts), which reports the URL
instead of launching anything on the environment. Replay accepts only the
[exact listener](../../apps/server/src/auth-relay/loopbackCallback.ts) the tool advertised, with
its state, and sends one raw request without redirects or logging. A successful callback request
is not proof that authentication finished; the flow reports success only when the native tool
confirms it. The native process owns token exchange and storage. Antigravity adds Google-only
checks on top of the generic rules; see
[its driver](../../apps/server/src/provider/AntigravityAuth.ts).

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
  report after Lathe's turn settles. Route subagent updates by subagent (not active run), request
  continuations when needed, and report pending background work so idle cleanup does not kill the
  session.
- **Terminal settlement.** Every terminal path (completion, Stop, provider error, process exit) must
  settle open tool calls, subagents, and pending requests.
- **Usage limits.** Classify quota/rate-limit errors as `usage_limit` (with reset time when
  available) rather than generic failures.
- **Symlinked workspaces.** Test symlinked paths (such as macOS `/tmp`); providers that compare
  canonical paths break if cwd handling disagrees.
