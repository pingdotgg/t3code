# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/orchestration-v2/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. The
[adapter](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) persists them as
`user_input_request` turn items and runtime requests with `responseCapability: { type: "message" }`.
Their execution nodes do not block the run. Web, desktop, and mobile use their normal question
panels, and requests remain pending after a turn finishes, a provider exits, or the server restarts.

`runtime-request.respond` reads the persisted request and question item, validates required
answers, and commits the resolution and a user message in one transaction. Repeating the same
command returns its receipt without posting the answer twice. The normal message path starts or
resumes a run, queues behind active work, or steers when the adapter supports it. Blocking questions
retain the provider's live response path. Do not infer that a request has disappeared merely because
it is outside the recent history window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. The
[attachment boundary](../../apps/server/src/orchestration-v2/AttachmentClaims.ts) validates and claims
uploads for a thread; adapters choose native input formats for those environment-local files.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

## Provider diagnostics

Native event logs retain lifecycle events, responses, and failures. Token deltas and duplicate raw
frames are filtered before adapters copy or redact payloads. The filter accepts both legacy native
events and v2 protocol envelopes; decode failures remain visible through diagnostic frames.

Log payloads have a 64 KiB encoded budget. Large or deeply nested payloads become structural
summaries that retain routing identifiers, methods, status, and error fields. Traversal is bounded
before redaction and serialization, so logging a large response does not require several full
copies. These limits apply to diagnostics; provider event handling is unchanged.

Codex resumes with metadata-only reads when it needs a thread's identity and update time. Its
initialization capabilities opt out of `turn/diff/updated`: T3 derives diffs from checkpoints.
The logger filters those notifications before traversal when an older provider still sends them.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).
