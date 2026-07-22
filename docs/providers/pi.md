# Pi

Pi is available in T3 Code as a first-class provider through Pi's CLI RPC mode.

T3 Code requires Pi CLI `0.81.1` or later. The integration's supported behavior and deferred-feature
list are defined against that version's RPC and extension protocols.

Install and authenticate Pi before adding it in T3 Code:

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

## Provider And Model Configuration

Configure credentials, built-in providers, custom providers, and models in Pi. T3 Code uses the
provider and model configuration Pi exposes, while separately managing runtime-instance settings and
UI-only preferences.

## Multiple Pi Instances

T3 Code supports multiple Pi runtime instances. Use separate instances when you need isolated Pi
configuration environments or session storage; configure the providers and models inside each Pi
environment.

An instance may optionally select a Pi configuration directory. When left empty, it uses the user's
normal Pi configuration; when set, T3 Code passes the directory as `PI_AGENT_DIR`. Session storage
remains isolated separately for every T3 Code Pi instance.

## Models

T3 Code discovers each instance's model catalog from Pi and shows it in the normal model picker.
Custom Pi providers and models therefore appear without duplicate T3 Code configuration. Available
thinking levels are supplied by Pi for the currently selected model.

## Runtime Settings

Each Pi runtime instance can set its binary path, an optional Pi configuration directory, optional
additional launch arguments, environment variables, display name, and accent color. T3 Code always
manages Pi's RPC mode, session directory, and thread session ID; additional arguments cannot override
those values.

## Initial Capability Scope

The first release targets provider parity for normal coding work:

- persistent, resumable Pi sessions
- streaming assistant text and tool activity
- image attachments
- stop/abort
- provider and model configuration
- Pi's configured enabled-tool policy
- streaming text and thinking
- tool calls, execution progress, and results
- retries, compaction, and queued work

## Tool Access

Pi manages tool access in the first release. Every tool enabled in the selected Pi runtime instance
may run without a T3 Code confirmation prompt. Configure Pi's enabled and disabled tools in Pi; T3
Code does not show its usual runtime-mode selector for Pi.

## Extensions

Pi loads the user's normal trusted global and project-local extensions. T3 Code does not install,
modify, or configure those extensions. It renders basic extension dialogs when Pi sends them through
RPC; custom terminal UI from an extension is reported as requiring Pi's terminal interface.

## Activity And Lifecycle

T3 Code maps Pi's supported RPC lifecycle events into its normal chat and work log, including text
and thinking streams, tool calls and execution progress, completed turns, retries, context
compaction, and queued work. Native Pi events are also retained in diagnostics for troubleshooting.

## Recovery

If a Pi RPC process or connection ends, T3 Code marks an in-flight turn interrupted and does not
replay it, avoiding duplicate tool calls. Continuing the thread starts Pi again with the same runtime
instance configuration and persisted native session.

## Continuing Threads

Pi threads continue only through the Pi runtime instance that created them. This preserves the Pi
configuration directory, extensions, credentials, model catalog, and isolated session storage used
by the thread.

## Session Storage

Threads created in T3 Code are native Pi sessions. T3 Code stores them in a Pi session directory
isolated to the selected Pi provider instance, using the T3 Code thread ID as the Pi session ID.

They do not appear in Pi's default session picker automatically. To access them directly through the
Pi CLI, launch Pi with that provider instance's `--session-dir` and select the saved session. T3 Code
will surface the exact location when the provider implementation is introduced.

## Deferred Until The Integration Is Stable

These are deliberate follow-up candidates, not unsupported-by-accident behavior:

- Pi extension-command UI and custom extension interactions
- Pi-specific session export, fork, and rollback controls
- Pi-native session browsing and management in T3 Code
- interactive per-tool approval: base Pi RPC auto-runs enabled tools; a supervised mode would require
  T3 Code to supply and maintain a Pi permission-gate extension over Pi's extension UI RPC protocol

Revisit this list after the core adapter has proven stable across session creation, resume, streaming,
tool execution, interruption, and reconnection.
