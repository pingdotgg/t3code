# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/orchestration-v2/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through orchestration and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state. For a new driver, start with [adding a provider](./adding-a-provider.md).

## Process and account isolation

The `opencode` driver probes the installed version and runs the 1.x or 2.x runtime. OpenCode's MCP
registrations are directory-scoped, while T3's MCP connection is thread-scoped, so threads in one
directory must not share one T3 MCP entry.

- **1.x** uses one T3-managed chat server per thread, so threads cannot replace each other's
  connection. Catalog and text-generation work can share the
  [instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
  after an idle period. See the [1.x adapter](../../apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts).
- **2.x** serves every directory from one
  [server per instance](../../apps/server/src/provider/opencode2/OpenCode2Server.ts). Each thread
  registers its own `t3-code-<thread>` MCP entry, and session permission rules deny every other
  thread's entry. See the [2.x adapter](../../apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.ts).

External OpenCode servers remain externally owned and can require an external restart to pick up
configuration changes. OpenCode stores "always" approval grants for the whole project. Automatic
full-access replies use `once` so they cannot widen a supervised thread's permissions on a shared
server. On 2.x, a session-wide approval also replies `once` and becomes T3's own rule on that session.

Pi runs the user's own `pi` install in RPC mode and owns native extension, package, and project
trust discovery. T3 injects only its namespaced MCP bridge, so a Pi session behaves as it does in
the Pi TUI. Pi session files back native resume, rollback, and same-instance thread forks.
Forks use Pi's CLI in the destination directory because RPC session switching retains the source
session's cwd. Provider switches still use portable handoff summaries.
See the [adapter](../../apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Managed ChatGPT sign-in for a remote environment can finish on a local primary. The
[primary handoff](../../apps/server/src/provider/CodexChatGptHandoff.ts) uses an ephemeral
credential store and the destination's environment ID. It exchanges and verifies the code before
transferring the issued client registration and tokens. Only the destination persists and refreshes
that session; retaining a primary refresh session would race refresh-token rotation. Without a local
primary, the client uses the remote callback completion flow.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A package manager runs only when the resolved executable's path proves it owns the install. Homebrew
and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global directories of pnpm, Bun, Yarn, and Vite+ may match on
either the resolved path or its real target, since those installers place real files or their own
symlinks there. Volta is proven by its `volta-shim` link plus the package's image directory. When
nothing is proven, the provider's own updater (`claude update`, `codex update`, `opencode upgrade`,
`pi update --self`, `grok update`) runs instead, because each one detects its installer itself;
the runner's version check catches an updater that exits 0 without updating. Mise installs stay
manual-only because their version is pinned in mise's config. npm updates pin `--prefix` because the
`npm` on `PATH` can belong to a different Node than the one that owns the provider. Homebrew
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

Native `/goal` state belongs to the provider and is mirrored on the provider thread. Codex starts
the next goal turn on its own milliseconds after the last one completes, so the
[adapter](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) keeps the run open
and adds that turn to it. One run can therefore own several native turns. `/goal` commands that
start no Codex turn settle on a provider turn without a native ref, which native rollback must
not count. Claude's SDK mode emits no goal events; its adapter reads goal state from the
synthetic command output and Stop hook feedback in the transcript.

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
