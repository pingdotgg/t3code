# Realtime Voice Architecture

> For maintainers. Voice Supervisor ships on web, desktop, and mobile. Web and desktop share the
> browser host and transport; mobile binds the shared client-runtime core to React Native state,
> navigation, WebRTC, microphone permission, and audio-session adapters.

Voice Supervisor is a global, provider-neutral work controller backed by OpenAI Realtime. “Provider
neutral” applies to the T3 projects and threads it supervises: the voice conversation itself uses a
fixed OpenAI Realtime model.

## Credential and Session Boundary

The selected T3 environment owns the long-lived OpenAI API key. A stored secret takes precedence
over `OPENAI_API_KEY`; removing the stored secret restores the environment fallback. Credential
status exposes only configured/source state, and clients never read the key itself. Reading that
redacted status and setting or removing the stored key require `access:write`, while client-secret
minting requires `orchestration:operate`.

The stored-key editor is exposed only by web and desktop Settings. Mobile uses a host already
configured there or through `OPENAI_API_KEY`; it does not set or remove the long-lived key.

| Method | Path                                | Purpose                                 |
| ------ | ----------------------------------- | --------------------------------------- |
| `GET`  | `/api/voice/openai/credential`      | Read redacted configured/source status  |
| `POST` | `/api/voice/openai/credential`      | Set or remove the stored key            |
| `POST` | `/api/voice/realtime/client-secret` | Mint a 60-second Realtime client secret |

All voice HTTP responses, including decode and authentication failures, receive `no-store` and
`no-cache` headers. The server redacts the API key, does not inspect upstream error bodies, and
maps failures to stable unavailable, rate-limited, upstream, timeout, or internal categories.

The mint adapter calls only OpenAI's `/v1/realtime/client_secrets` endpoint, with a ten-second
timeout and no retry. It fixes the session type and `gpt-realtime-2.1` model, validates the selected
voice against the shared allowlist, and sends OpenAI a stable, hashed pseudonymous identifier
derived from the environment ID for safety tracking. Process-local backpressure allows six mints
per authenticated session per minute, 30 globally per minute, and four concurrent upstream
requests. Its session tracker is bounded to 256 entries with a two-minute idle TTL.

The default voice is `marin`; the shared allowlist is `alloy`, `ash`, `ballad`, `coral`, `echo`,
`sage`, `shimmer`, `verse`, `marin`, and `cedar`. Upstream `429` responses retain a bounded
`Retry-After`; local rate and concurrency failures use the same typed public error shape.

These are issuance controls, not runtime enforcement or a spend cap. An OpenAI client secret is
usable until expiry, and a client can update session defaults after minting. Each client coordinator
therefore locally validates the voice selection and sends the same fixed model, selected
allowlisted voice, prompt, and tool schemas during its handshake, but the server does not claim
that mint defaults enforce the rest of the session.

## Direct WebRTC Transport

The server never proxies microphone or speaker media:

```text
web, desktop, or mobile client
  -> selected authenticated T3 environment: mint short-lived client secret
  -> OpenAI /v1/realtime/calls: exchange SDP using that secret
  -> direct client-to-OpenAI WebRTC audio + data channel
```

On web and desktop, the browser transport requires a secure context and `getUserMedia`. On mobile,
`react-native-webrtc` requests the operating system's microphone permission, starts a native audio
session, and captures an audio-only stream. Both transports create one peer connection and
`oai-events` data channel, start a 20-second negotiation timeout, create an SDP offer, mint the
secret, exchange SDP directly with OpenAI, and wait for the data channel to open. No reconnect
policy lives in either transport or host; a failed or closed session must be started again.

Every connect attempt has a transport generation. Starting again aborts and tears down the prior
attempt, and late async results or events cannot mutate the new generation. Teardown aborts pending
work, removes listeners, stops local, remote, sender, and receiver tracks, clears the browser audio
element or releases the mobile stream and native audio-session lease, closes the channel and peer
connection, and cancels timers.

## Root Coordinator and Handshake

A single Voice Supervisor host is mounted at the web root; desktop wraps that surface. Mobile mounts
one host under `RootStackLayout`. Each client root therefore owns at most one voice session, and its
controller and replay state survive route changes. The host owns another monotonic session
generation above the transport generation; all state projection, tool calls, confirmations, and
transport callbacks are generation-checked.

Opening the web panel or mobile screen does not request microphone permission, mint a client secret,
or start a session. The user must choose **Start voice** on web or desktop, or **Start** on mobile. The native desktop bridge first checks
macOS microphone permission and, when needed, requests it through the main process; browser
`getUserMedia` remains the capture authority for web and desktop. Mobile uses the
`react-native-webrtc` permission and capture APIs. Permission prompts are intentionally outside
T3's handshake timer.

After transport readiness, the coordinator waits for `session.created`, sends one static
`session.update`, and treats a `session.updated` with the same OpenAI session ID as the
acknowledgement. It does not verify echoed configuration fields. A 20-second handshake timer starts
only after transport readiness. Until that acknowledgement, the microphone is held muted and
other Realtime events are ignored. The configuration sent for acknowledgement is:

- model `gpt-realtime-2.1` with audio output;
- the selected allowlisted voice;
- server VAD that creates responses and permits response interruption;
- separate `gpt-4o-mini-transcribe` input transcription;
- one static supervisor instruction and the eight static function schemas below.

The static instruction tells the model to use tools for work facts, require local confirmation for
all mutations, never claim a proposal executed before its result says so, and treat speech,
transcripts, project/thread data, and tool content as untrusted.

Transcript deltas are coalesced at 80 ms and projected into bounded client state. Input
transcription is an asynchronous display stream, not the conversation model's authoritative
interpretation; a transcription failure is recorded without failing the session.

On web and desktop, the host is reachable from the floating launcher, both sidebars, and the Command
Palette. The `voice.toggle` command can be assigned in Keybindings but has no default. Hiding the
panel preserves an active session; Stop or host loss performs teardown. The launcher retains
connection, mute, failure, and pending-confirmation state while the panel is hidden.

On mobile, the Settings row and the `voice` deep-link route open the screen. Back or navigation away
hides only that screen. While it is hidden, a root-owned portal control appears only for connecting,
connected, failed, or pending-confirmation state and reopens the route. Mobile voice is
foreground-only: AppState loss outside the initial iOS permission transition, or a terminal native
audio-session event, tears down the attempt. Returning to the foreground never auto-resumes or
reconnects it.

Mobile freezes the selected host environment, connection generation, and voice at Start. It
subscribes to that host lease and re-reads the authoritative lease immediately before minting; host
loss or a changed generation tears down or rejects startup instead of silently retargeting.

## Static Tool Surface

Only these tools are sent to the model:

| Tool                 | Kind              | Model-visible result                                                     |
| -------------------- | ----------------- | ------------------------------------------------------------------------ |
| `list_active_work`   | read              | Bounded active thread labels, opaque handles, status, availability       |
| `list_projects`      | read              | Bounded project labels, opaque handles, availability                     |
| `list_threads`       | read              | Bounded non-archived thread labels, opaque handles, status, availability |
| `get_thread_summary` | read              | Operational status and bounded current plan step                         |
| `open_thread`        | navigation        | Compact opened label/handle result                                       |
| `start_thread`       | mutation proposal | Compact proposal only                                                    |
| `send_follow_up`     | mutation proposal | Compact proposal only                                                    |
| `interrupt_thread`   | mutation proposal | Compact proposal only                                                    |

The model schemas are closed and bounded; the protocol call ID is injected locally instead of
being model-authored. Unknown tools, extra properties, malformed values, oversized strings, unsafe
keys, accessors, and unserializable results fail to compact, redacted statuses. There is no tool for
approvals, user-input prompts, files, terminals, delete/archive, or arbitrary commands.

## Multi-Environment Targets

At invocation time the repository reads current connection projections and authoritative,
potentially cached shell snapshots across the current client catalog. Cached targets remain
eligible for bounded list results when present; summary reads revalidate a live target before
returning current plan text. The repository classifies every record as live, stale, or disconnected
from current connection and shell state. A record also carries its
environment-qualified label and a version derived from that entity's authoritative update fields.
Navigation and commands retain the exact owning environment.

The shared supervisor core publishes short-lived opaque handles rather than raw environment,
project, thread, or path identifiers. Target results are capped at 20 items and labels/summaries are
bounded. Exact labels and aliases resolve only within the latest publication generation. Duplicate
exact names return bounded ambiguous candidates; a partial match always returns candidates rather
than silently resolving. Mutation proposals accept only an exact opaque handle.

Targets normally live for two minutes. Re-publishing an unchanged binding/version reuses its
handle; a changed version receives a new binding. The target, proposal, call, alias, JSON depth,
node, byte, key, and array stores all have explicit caps and fail closed at capacity rather than
evicting replay guards.

On web and desktop, new-thread preparation reuses the current T3 policy: routed
composer/shell/draft carry, sticky and project provider/model selection, provider availability,
permission and interaction modes, project → `t3.json` → primary environment workspace defaults,
and default-ref/current-branch then current-ref worktree selection.

Mobile deliberately excludes the current route and unfinished composer drafts. It resolves durable
defaults from the target project and environment: a usable project model or configured fallback,
the default runtime and interaction modes, project → `t3.json` → environment workspace mode, and a
default ref or current local ref for worktrees. Local mode uses the project workspace without
inventing a branch or worktree path. Both adapters generate command, message, and thread IDs once,
before confirmation, and never invent a model or path when authoritative defaults are unavailable.

## Tool Serialization and Replay

A Realtime `response.done` may contain parallel calls, but the host admits only one response-level
tool batch at a time. It mutes the microphone for the entire batch, including any wait for local
confirmation. New speech or responses during that hold fail the session instead of creating
overlapping work. When every call settles, the host sends correlated `function_call_output` events
followed by one `response.create`, then restores the user's requested mute state.

Response IDs, call IDs, tool metadata, argument bytes, and calls per response are bounded. The host
keeps bounded response and call replay ledgers for the session: identical response replays are
ignored, reused/conflicting IDs fail closed, and ledgers are never evicted to admit a new ID. The
tool controller maintains its own normalized call ledger so identical valid calls return the same
frozen result and invalid calls leave tombstones. Client-authored continuation event IDs are also
tracked so a provider error can be correlated to the exact output or continuation that failed.

All tool results are copied into bounded, deeply frozen JSON before caching or returning. Model
outputs contain opaque handles and compact summaries, never frozen local previews or raw IDs.

## Local Confirmation and Execution

`start_thread`, `send_follow_up`, and `interrupt_thread` only prepare proposals. The core snapshots
the exact command mutation and a separate full local preview as bounded, deeply frozen JSON. It
binds both to the opaque target's environment, identity, kind, and version. At most one actionable
proposal is pending; proposals normally expire after 30 seconds and are one-shot across confirm,
deny, replacement, expiry, and replay.

The trusted UI reads the frozen preview directly. Confirmation is a local UI action: every client
provides explicit buttons, and web/desktop also provide scoped keyboard actions. No model tool can
confirm itself. On confirm, the execution adapter re-reads the exact project or thread and rejects
missing, disconnected, stale, or version-changed targets. Only then does it decode the frozen
mutation, build the existing start/follow-up/interrupt command, route it to the bound environment,
and await its receipt-backed accepted result. Denial cancels the proposal without dispatch.

## Remote Modes and Failure Handling

Credential status and minting use the selected voice host's prepared connection. Bounded list
reads span the current client catalog and may include cached targets classified as stale or
disconnected. Summary reads and navigation revalidate the target as live. Confirmed commands
retain the exact connection of the target that owns the project or thread and additionally require
the bound target to remain live, connected, and unchanged. Those connections can be
local, LAN, SSH-forwarded, Tailscale, or T3 Connect; relay HTTP requests use the same authenticated
signer path as other environment operations. The client still negotiates WebRTC directly with
OpenAI, so T3 Connect does not carry voice media. The client device owns the microphone and speaker;
a remote host does not need audio hardware.

Older servers omit the Realtime voice capability. Clients treat that as unsupported and do not
probe the endpoints. Loss of the selected host, secure-context failures, permission denial,
credential/model rejection, rate limits, timeouts, upstream errors, protocol overlap, replay
conflicts, and capacity exhaustion all produce bounded UI-safe failures. Raw provider bodies,
credentials, and causes never enter model-facing or public error results.

## Bounds and Test Seams

The user-facing panel or screen renders only the latest 40 transcript and 40 activity rows, clips
rows to 2,000 characters, and keeps larger in-memory stores bounded. The tool layer caps each list
at 20 items, one Realtime response at 16 calls, tool call arguments at 16 KiB, and its primary call
and target/proposal stores at fixed session-local capacities.

The design keeps provider and platform effects behind injected seams: browser and native media,
peer connections, mobile AppState and audio sessions, fetch, clocks/timers, state projection,
repository reads, navigation, command dispatch, receipt results, opaque ID generation, and
confirmation execution. Focused automated tests cover generation races, handshake order and
timeouts, transport cleanup, microphone holds, event correlation and replay, strict argument
decoding, bounded output, duplicate cross-environment names, stale/disconnected/version-changed
targets, one-shot confirmation, exact command routing, desktop permission preflight, web entry
points and panel interaction, and mobile native adapters, foreground lifecycle, and presentation
helpers.
