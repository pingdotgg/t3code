# VoiceBud local draft bridge

T3 Code Desktop exposes an optional, macOS-only bridge for the local VoiceBud
process. It is intentionally not part of the server RPC surface: composer
drafts live in the web renderer, and exposing this operation through the T3
server would make a local UI concern remotely reachable.

## Discovery and transport

While the production T3 Code Desktop app is running, it writes:

```text
~/.t3/userdata/integrations/voicebud/bridge.json
```

Development builds use `~/.t3/dev/integrations/voicebud/bridge.json`. When
`T3CODE_HOME` is configured, it replaces the `~/.t3` prefix. Keeping discovery
inside the instance state directory prevents development and production apps
from overwriting each other's descriptor; VoiceBud must select the descriptor
for the focused T3 Code application.

The directory is mode `0700`; the descriptor and Unix domain socket are mode
`0600`. The descriptor is replaced atomically and has this shape:

```json
{
  "version": 1,
  "transport": "unix",
  "socketPath": "/absolute/private/path/bridge-<pid>-<random>.sock",
  "secret": "<32 random bytes encoded as base64url>",
  "pid": 1234
}
```

The secret rotates on every desktop run. VoiceBud must reject a descriptor
with an unexpected version/transport, unsafe ownership or permissions, a
non-absolute socket path, or a socket outside the descriptor directory.
Neither the descriptor nor any request may be logged.

The socket accepts one newline-delimited JSON request per connection and
returns one newline-delimited JSON response before closing. Clients should use
a two-second connect/write timeout and allow six seconds for the response,
which includes renderer delivery. A frame is limited to 64 KiB and a transcript
to 32,768 characters.

## Requests

Every request contains:

- `version`: `1`
- `requestId`: a fresh opaque id
- `recordingId`: a fresh immutable id created before recording starts
- `nonce`: a fresh opaque id for every attempt
- `sentAt`: Unix epoch milliseconds, within 15 seconds of T3 Code's clock
- `auth`: the descriptor's random secret

Ids are 1–128 characters and use only ASCII letters, digits, `.`, `_`, `:`,
and `-`.

To begin a recording:

```json
{
  "version": 1,
  "type": "recording.started",
  "requestId": "01-start",
  "recordingId": "01-recording",
  "nonce": "01-nonce",
  "sentAt": 1800000000000,
  "auth": "<secret>"
}
```

T3 Code does not accept a destination from VoiceBud. It asks its trusted
renderer for the currently mounted composer identity and binds the
`recordingId` to either the exact `(environmentId, threadId)` pair or the exact
`DraftId`. The response is accepted only after that binding succeeds:

```json
{
  "version": 1,
  "requestId": "01-start",
  "accepted": true,
  "code": "accepted"
}
```

After local STT and post-processing finish:

```json
{
  "version": 1,
  "type": "transcription.completed",
  "requestId": "01-complete",
  "recordingId": "01-recording",
  "nonce": "02-nonce",
  "sentAt": 1800000001000,
  "auth": "<secret>",
  "transcript": "Final locally processed text"
}
```

T3 Code appends the transcript atomically to the bound composer draft,
preserving any text entered while processing. It never invokes the send path.
The external response is accepted only after the renderer acknowledges the
draft write. Once delivery to the renderer is attempted, the `recordingId` is
consumed regardless of the acknowledgement outcome. This fail-closed rule
prevents an ambiguous retry from appending the same transcript twice.

Possible rejection codes are:

```text
authentication_failed, expired, malformed, oversized, rate_limited, replay,
duplicate_recording, unknown_recording, renderer_unavailable, delivery_failed,
delivery_ambiguous
```

`delivery_failed` means the renderer explicitly rejected the draft write.
`delivery_ambiguous` means the acknowledgement was lost or timed out after
delivery was attempted, so the write may already be present. Neither outcome is
retryable. Request ids and nonces are one-shot; after a completion request has
been written to the socket, VoiceBud must not retry it. A connection failure
that happened before any request bytes were written may be retried with a new
request id and nonce.

## Required VoiceFlow changes

The current VoiceFlow implementation has a process-local integer
`sequence_id`, captures the Accessibility destination when recording stops,
and injects final text through clipboard/keystrokes. It has no external
`recording_id` or T3-specific delivery sink. T3 Code does not modify that
repository.

VoiceFlow needs a bounded T3 destination adapter with these changes:

1. When the hotkey starts while T3 Code is the focused application, create a
   cryptographically random `recording_id` and complete the
   `recording.started` exchange before reserving T3 delivery.
2. Carry that id and a dedicated T3 destination through `AudioJob`; do not use
   the later Accessibility focus target for this job.
3. After normalization/post-processing, send `transcription.completed` instead
   of calling `TextInjector.inject`.
4. If descriptor validation, connection, authentication, binding, or delivery
   fails, do not fall back to typing into whichever field is focused. Leave the
   result on the clipboard or report a local delivery error. Treat an absent
   completion response and `delivery_ambiguous` as non-retryable.
5. Keep transcript/auth data out of logs, enforce the limits/timeouts above,
   and allow multiple independent in-flight recording ids.

The existing non-T3 dictation path can remain unchanged.
