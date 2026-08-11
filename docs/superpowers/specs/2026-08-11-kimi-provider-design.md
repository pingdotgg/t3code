# Kimi Provider Design

## Summary

Add Kimi Code CLI as a first-class T3 Code provider using the official `kimi acp` stdio
interface. The provider uses the driver kind and default instance ID `kimi`, appears as **Kimi**
throughout T3 Code, and initially carries the same **Early Access** badge used by Cursor and Grok.

Early Access describes rollout maturity, not an intentionally reduced feature set. The integration
targets the full capability surface exposed by the installed Kimi ACP server and degrades honestly
when the CLI does not advertise an optional feature.

## Goals

- Make Kimi available from web, desktop, and mobile wherever another provider can be selected or
  configured.
- Support the complete T3 thread lifecycle: create, resume, prompt, steer, interrupt, stop, and
  recover after server or client reconnects.
- Support streaming assistant output, plans, tool activity, approvals, structured user questions,
  attachments, MCP servers, models, thinking options, interaction modes, skills, and slash commands
  to the extent the installed Kimi ACP implementation exposes them.
- Support Kimi-backed thread titles, branch names, commit messages, and change-request text.
- Support multiple isolated Kimi instances with independent binary paths, homes, credentials,
  environments, display names, and accent colors.
- Preserve T3 Code's remote-ready architecture: Kimi runs on the T3 server machine and all clients
  use the existing typed orchestration surface.
- Match existing provider naming, settings, status, logging, testing, and documentation conventions.

## Non-goals

- Reimplement Kimi's private runtime or depend on undocumented wire protocols.
- Emulate interactive TUI features that Kimi does not expose over ACP.
- Add a limited legacy `--prompt --output-format stream-json` session adapter for pre-ACP CLIs.
- Refactor Cursor, Grok, or the entire ACP provider stack as part of this feature.
- Advertise unsupported ACP features such as audio prompt blocks, logout, or unstable editor APIs.
- Bundle the Kimi CLI with T3 Code.

## Product Naming and Presentation

Use these names consistently:

| Concept | Value |
| --- | --- |
| Driver kind | `kimi` |
| Default instance ID | `kimi` |
| Product label | Kimi |
| CLI label in diagnostics and documentation | Kimi Code CLI |
| Settings schema | `KimiSettings` |
| Driver | `KimiDriver` |
| Provider snapshot module | `KimiProvider` |
| Runtime adapter | `KimiAdapter` |
| ACP integration helpers | `KimiAcpSupport` |
| Auxiliary generation service | `KimiTextGeneration` |
| Home environment variable | `KIMI_CODE_HOME` |

Kimi receives a dedicated `KimiIcon` based on the official mark and is present in provider settings,
model pickers, thread settings, new-thread flows, and mobile provider grouping. Its provider client
definition includes `badgeLabel: "Early Access"`. The default built-in Kimi instance is visible but
disabled until the user enables it, matching other Early Access providers.

## Architecture

### First-class driver

Register `KimiDriver` in `BUILT_IN_DRIVERS`. The driver owns Kimi configuration decoding, process
environment construction, continuation identity, provider status, the runtime adapter, maintenance
capabilities, and auxiliary text generation. No orchestration branch should depend on `kimi`; the
existing `ProviderAdapter` and canonical runtime events remain the boundary.

The driver supports multiple instances. Each call to `create` owns its subprocesses, scopes, event
stream, session map, pending interactions, and text-generation runtime. No mutable state is shared
between instances.

### Dedicated adapter on shared ACP infrastructure

`KimiAdapter` is provider-specific but builds on the existing `effect-acp` client,
`AcpSessionRuntime`, ACP event parsers, native logging, attachment store, and MCP conversion code.
Small provider-neutral helpers may be extracted from the Grok or Cursor adapters when reuse is
direct and independently testable. This work must not turn into a generalized ACP-provider rewrite.

The adapter translates Kimi ACP messages into the same canonical events used by other providers:

- assistant item start, text deltas, and completion
- plan updates
- tool start, progress, output, completion, and failure
- approval opened and resolved
- structured user-input opened and resolved
- turn completed, interrupted, or failed
- session state and resume cursor changes

### Existing contracts first

The current contracts already carry open provider driver slugs, opaque resume cursors, models,
provider option descriptors, slash commands, skills, attachments, approval requests, structured
questions, plans, and tool events. The implementation uses those contracts without adding Kimi-only
wire shapes. A contract change is allowed only when an upstream capability cannot be represented
faithfully by the existing canonical model and the change is useful across providers.

## Configuration

`KimiSettings` follows the annotated provider-settings schema convention and contains:

- `enabled`, default `false` and hidden in the generic form
- `binaryPath`, default `kimi`
- `homePath`, an optional `KIMI_CODE_HOME` path
- `launchArgs`, optional extra global Kimi CLI arguments, tokenized with the repository's existing
  shell-safe launch-argument utility and placed before the `acp` subcommand
- `customModels`, hidden in the generic form and merged with discovered models

Provider-instance environment variables are merged through the existing secret-aware environment
system. An explicit instance environment value wins over the inherited process environment.
`homePath`, when non-empty, is resolved using the same cross-platform path conventions as other
provider homes and becomes `KIMI_CODE_HOME` for probes, sessions, and auxiliary generation.

The adapter always owns the transport suffix and launches `<binary> <launchArgs> acp`. User launch
arguments may configure Kimi but may not replace the ACP subcommand or stdio transport.

## Compatibility and Capability Negotiation

Compatibility is capability-based rather than tied to a hard-coded version number. A health probe
runs `kimi --version`, starts `kimi acp`, sends `initialize`, and inspects the response.

The following are required for a usable provider:

- ACP initialization
- `session/new`
- `session/prompt`
- `session/cancel`
- `session/update` notifications carrying assistant output
- `session/request_permission` when the runtime asks for approval

If this core surface is unavailable, Kimi remains visible with an actionable message to update to an
ACP-capable Kimi Code CLI. Optional capabilities are enabled only when advertised:

- `session/load`, `session/resume`, and `session/list`
- session model or config-option mutation
- session modes
- image and embedded-resource prompt blocks
- stdio, HTTP, and SSE MCP forwarding
- available-command updates

Missing `session/close` is handled by closing the adapter-owned process and scope. Missing `logout`
is documented; T3 does not pretend to provide it. Unknown extension messages are logged safely and
ignored unless they affect the active request.

## Provider Status, Authentication, and Maintenance

The provider snapshot distinguishes these states:

1. disabled in T3 settings
2. binary not found
3. version probe failed or timed out
4. ACP handshake unsupported or incomplete
5. authentication required
6. ACP model discovery failed or timed out
7. ready

Authentication is checked through ACP initialization/authentication and session startup. T3 does
not open an interactive login TUI inside a server process. When login is required, the status message
instructs the user to run `kimi login` on the environment hosting T3, with the same `KIMI_CODE_HOME`
when a custom home is configured. Provider-specific environment variables allow API-key based Kimi
configurations without sending secrets to clients.

Maintenance metadata recognizes the official `@moonshot-ai/kimi-code` package where the existing
provider maintenance resolver can manage it. Standalone installations remain supported and receive
manual official upgrade guidance rather than an unsafe package-manager assumption.

## Model and Option Discovery

The status probe creates a short-lived ACP session after authentication and reads the returned model,
mode, and config-option state. Discovered models are normalized into `ServerProviderModel` entries and
merged with `customModels` without duplicates.

Where Kimi changes config options after a model switch, the probe may switch models inside its
throwaway session and collect the resulting option descriptors without sending an LLM prompt. Probe
work is bounded by a total timeout and publishes the best valid partial model list if optional option
discovery fails.

Model capabilities use T3's generic provider option descriptors. Kimi-advertised thinking and other
select or boolean values appear in both web and mobile model settings. On a real session, the adapter
applies configuration in this order:

1. model
2. the selected model's provider options
3. interaction/plan mode
4. prompt

The order matters because Kimi may change available options after a model switch. Unsupported or
stale stored options are omitted with a diagnostic log instead of failing the whole turn.

Kimi supports in-session model switching when the active ACP session advertises it. Otherwise T3
marks model changes as requiring a new thread/session instead of displaying a control that cannot
work.

## Permission and Interaction Modes

T3's four runtime modes map at the adapter boundary:

- **Supervised** (`approval-required`): ask for command and file-change requests.
- **Auto-accept edits**: automatically accept file edits while continuing to ask for commands and
  other actions.
- **Auto**: select Kimi's advertised automatic mode when one exists; otherwise fall back to
  supervised behavior.
- **Full access**: automatically accept ordinary tool requests for the session.

The adapter chooses ACP permission options by their semantic kinds (`allow_once`, `allow_always`,
`reject_once`) rather than assuming fixed option IDs. A user decision that Kimi cannot represent
returns a typed error instead of silently selecting a different outcome.

T3's **Plan** interaction mode selects an advertised Kimi plan mode by exact ID/name aliases and
falls back to Kimi's config-option mode path where supported. If plan mode is not advertised, the
toggle is hidden for Kimi rather than simulated in the prompt.

Question-shaped requests from Kimi are translated to canonical structured user input and remain
interactive even in Full access. Tool approval requests continue through the approval UI. Stopping,
interrupting, or losing the process resolves pending interactions as cancelled so no request hangs.

## Session and Turn Lifecycle

The opaque resume cursor is a versioned object containing the Kimi ACP session ID. Invalid or future
cursor versions are rejected safely and cause an explicit new-session or unsupported-resume outcome;
they never reach Kimi as unchecked input.

Session startup performs:

1. construct the isolated process environment
2. launch `kimi acp`
3. initialize ACP with T3 client capabilities
4. register permission, file, terminal, session-update, and extension handlers
5. load, resume, or create the Kimi session
6. apply the requested model and modes
7. publish a ready canonical session with its resume cursor

`session/load` is preferred when history replay is required. `session/resume` is used when available
and replay is unnecessary. If a CLI advertises neither continuation method, existing threads fail
with upgrade guidance rather than silently creating unrelated Kimi history.

Each T3 turn owns a stable turn ID even when the user steers while a Kimi prompt is still active.
Prompt settlement, interruption, queued event draining, and late notification checks are serialized
per thread. Late results from a replaced process or session cannot revive an interrupted or completed
turn. `stopSession` and driver scope closure terminate only processes created by that provider
instance.

## Attachments, File Access, Terminals, and MCP

- Text prompt content is sent as ACP text blocks.
- Images are loaded through the attachment store and sent as native ACP image blocks only when Kimi
  advertises image input.
- Text resources and links use embedded ACP resource blocks when advertised.
- Other local files, including audio or video, are represented as explicit workspace file references
  so Kimi can inspect them with its own tools when possible. T3 does not claim native audio ACP input.
- ACP file read/write reverse calls use T3's scoped filesystem handlers.
- Kimi shell commands execute on the T3 server environment. If Kimi uses local shell execution rather
  than ACP terminal reverse calls, the canonical tool stream still reports their lifecycle and output.
- Configured stdio, HTTP, and SSE MCP servers are forwarded through `session/new` and continuation
  calls according to Kimi's advertised MCP capabilities. Unsupported ACP-as-MCP transports are
  omitted with a warning.

## Skills and Slash Commands

Kimi skills are discovered using its documented priority locations, including the configured
`KIMI_CODE_HOME`, user-level `.agents/skills`, project-level `.kimi-code/skills` and `.agents/skills`,
and valid extra skill directories from Kimi configuration where safely readable. Project entries win
name collisions. Malformed or unreadable skill metadata is skipped without failing provider health.

The provider snapshot exposes discovered entries as `ServerProviderSkill` so the existing web and
mobile `$`/skill pickers and inline rendering work unchanged.

The ACP runtime parses `available_commands_update` notifications during the bounded probe session
and exposes them as `ServerProviderSlashCommand`. Built-in commands and skill commands are deduped by
their canonical name. Commands remain plain prompt input; T3 does not try to execute TUI-only panels
it cannot host.

## Auxiliary Text Generation

`KimiTextGeneration` uses a short-lived, scoped Kimi ACP session with the selected model. It collects
assistant text, enforces the existing structured JSON prompts and sanitizers, and implements:

- thread-title generation
- branch-name generation
- commit-message generation
- change-request title/body generation

It has a bounded timeout, validates structured output, reports empty or cancelled responses, and
closes its ACP process on every exit path. It does not reuse a user's active thread or contaminate
that thread's Kimi history.

## Error Handling and Observability

All expected failures become typed provider or text-generation errors. Important cases include a
missing binary, malformed launch arguments, startup timeout, failed capability negotiation, required
authentication, invalid resume cursor, model/config rejection, malformed ACP events, prompt timeout,
process exit, unsupported attachments, and stale permission responses.

Native ACP input/output may be recorded through the existing provider native logger for diagnostics.
Secrets and sensitive environment values are never included in provider snapshots or client events.
Logs prefer bounded lengths and structural metadata over raw payload dumping. Canonical provider
events remain the only client-facing runtime stream.

Stopping a session, interrupting a turn, losing the subprocess, or closing an instance scope settles
pending approvals and user questions, drains owned fibers, and prevents resource leaks.

## Surface Coverage

- **Web:** provider settings, icon, status card, model picker, provider options, composer permission
  and plan controls, skills, slash commands, and thread continuation.
- **Desktop:** the shared web surface plus server-side binary discovery and environment behavior in
  the Electron-hosted server.
- **Mobile:** provider/model grouping, Early Access presentation where shown, options, permission and
  plan controls, skills, slash commands, approvals, questions, and remote thread continuation.
- **Connection modes:** local, relay, and tunnel require no Kimi-specific client path because all CLI
  work remains server-side.
- **Reverse states:** Kimi sessions can be stopped and restarted/resumed; modes can return to their
  non-plan and supervised states; provider instances can be disabled and re-enabled.

## Testing Strategy

Implementation follows red-green-refactor. Every behavior change begins with a focused failing test.

### Contracts and settings

- `KimiSettings` defaults, annotations, decoding, normalization, and persistence
- default Kimi instance migration/bootstrap behavior
- secret-aware environment merging and `KIMI_CODE_HOME` resolution

### CLI and provider snapshot

- command and argument construction on Windows, macOS, and Linux
- disabled, missing, timed-out, upgrade-required, unauthenticated, discovery-failed, and ready states
- version parsing, maintenance metadata, model deduplication, and option mapping
- skill and slash-command discovery, priority, deduplication, and malformed input

### ACP runtime and adapter

A deterministic Kimi ACP mock peer covers:

- initialize and capability negotiation
- new, load, and resume session paths
- model and config-option application order
- plan/default mode switching
- all four permission modes and semantic permission option selection
- assistant streaming and segmented messages
- plans and complete tool lifecycle events
- approvals and structured questions
- text, image, and embedded-resource prompts
- stdio, HTTP, and SSE MCP forwarding
- steering, interruption, stop, prompt failure, process exit, and late events
- resume cursor validation and history replay
- multiple simultaneous provider instances with no shared state

### Auxiliary generation

- each generated content type
- selected model application
- structured output validation, sanitization, timeout, cancellation, empty output, and cleanup

### Clients

- web provider metadata, icon lookup, settings rendering, model groups/options, commands, and skills
- mobile provider labels, model groups/options, commands, skills, and continuation selection
- unknown-provider fallbacks remain intact

### Focused integration

Add a server integration fixture for a Kimi session flowing through orchestration ingestion and
checkpointing. A separate opt-in live smoke probe performs only an ACP handshake/model discovery
against an installed official Kimi CLI; it does not send a billable LLM prompt.

Run only focused tests, targeted lint/type checks, and relevant builds. A real browser or mobile
client pass requires explicit approval under the repository's computer-use policy.

## Documentation

- Add `docs/user/providers-kimi.md` with installation, login, custom home, multiple-instance,
  permissions, models, and troubleshooting guidance in shipped-product language.
- Update `docs/internals/providers.md` with the sixth built-in driver and its ACP boundary.
- Update relevant provider lists or screenshots only where the product surface requires it.
- Document upstream ACP limitations without presenting them as T3 functionality.

## Upstream Limitations

The current official Kimi ACP documentation does not expose `session/close`, logout, native audio
prompt blocks, ACP terminal reverse calls, or most unstable editor APIs. T3 compensates only where it
can do so faithfully—for example, closing the owned process when `session/close` is absent. Other
features are hidden or documented until Kimi exposes them.

Primary upstream references:

- <https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html>
- <https://moonshotai.github.io/kimi-code/en/reference/kimi-command>
- <https://moonshotai.github.io/kimi-code/en/customization/skills>
- <https://github.com/MoonshotAI/kimi-code>

## Rollout

Ship Kimi with an **Early Access** badge and default it to disabled. The badge can be removed in a
later focused change after supported Kimi versions have been exercised across operating systems,
authentication methods, model configurations, long-running sessions, reconnects, and remote clients.
No intentionally incomplete code path is justified by the badge.
