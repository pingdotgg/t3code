# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text to the agent. Mobile defaults to on-device transcription. Sending audio off
the device requires an explicit grant naming one environment and, for cloud
transcription, one provider.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. A
transcriber may expose a streaming session, in which case audio leaves during
capture and `finish` replaces the file-based `transcribe`.

## Where audio may go

On mobile, on-device transcription needs no audio grant. Environment and cloud
transcription share a recorder and upload only finished recordings. The client
keeps the grant in device-bound secure storage, outside preference backups, and
rechecks it after native decoding and before upload.

The [web grant](../../apps/web/src/speech/voiceConsent.ts) lives outside the preferences snapshot so another
window saving unrelated settings cannot resurrect a revoked grant. Each new choice
gets a distinct grant, even if the destination was previously selected. The
[web hook](../../apps/web/src/speech/useEnvironmentSpeechInput.ts) binds the
controller to that grant and the selected environment's connection. It requires
`voiceTranscription` to use the environment's model or `cloudVoiceTranscription`
to forward audio to the selected provider. Changing the grant or losing the
connection, permission, or required capability discards both the active recording
and any recording retained for retry. It never chooses a fallback destination.
The settings page's transcription test uses the same hook. The microphone loopback
test captures separately for local playback and sends nothing. The transport
refuses redirects so credentials and audio cannot follow one to another host.

Transcript cleanup requires its own grant, off by default.
It sends text, never audio, to the text generation provider of the draft's
own environment, because that is where the provider credentials live.

A cloud destination binds both the forwarding environment and the named provider.
It uses a separate, batch-only endpoint: changing a server key cannot upgrade
an environment-local grant, and a cloud recording never uses the streaming
socket or falls back to another provider or the environment's native model.

OpenRouter routes to many upstreams, so its grant also names the exact model and
the model travels with every upload as a query parameter. The server accepts only
ids present in OpenRouter's public ZDR-eligible transcription catalog,
which it caches for ten minutes after a successful read;
router aliases such as `openrouter/auto` or `:nitro` fail schema validation before
that. Requests set `provider.zdr` and carry no `models` fallback list. OpenRouter
applies the account's safety-retention policy when choosing an endpoint. The catalog
holds no credential or consent state, which is why it may be cached while key
presence is read fresh on every request.

## Server side

The [speech service](../../apps/server/src/speech/SpeechService.ts) runs
transcribe-cpp in a child process so a hung native call can be killed without
taking the server down; see [native.ts](../../apps/server/src/speech/native.ts)
for the packaging constraints (Node SEA, Electron ASAR). One native request runs
at a time. Batch uploads carry their options in the body framing defined in
[shared/speech.ts](../../packages/shared/src/speech.ts); streaming sends them in
the socket's first command. Model files and the selected model, hardware
placement, and unload timeout are environment state in server settings.

The Silero silence detector is optional. If its download fails, recordings use
raw audio during the retry cooldown so a detector outage cannot block dictation.
Explicitly installing a speech model also retries the detector without waiting.

## Cancellation and resource ownership

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results. On the server,
interrupting a batch request kills the worker process instead; the next request
reloads the model.

## Realtime voice sessions

The voice panel is a second, separate path: it holds a live GPT-Live call and
submits agent turns. Spoken requests never reach a provider directly. The
session's only tool hands the request to
[`delegateVoiceRequest`](../../apps/server/src/voice/voiceDelegation.ts), which
dispatches `thread.turn.start` on the task voice started in and waits for that
turn's assistant messages, so the task's own model selection, runtime mode and
approvals decide what happens. Messages are collected per turn id because a
provider can still be flushing the previous turn when the new one starts, and an
empty-text `thread.message-sent` is a streamed message's final marker, not its
body — overwriting the collected text with it loses the answer.

GPT-Live raises the same question two or three times, worded slightly
differently and delivered one at a time. Only the first starts a turn: a ping
that lands mid-turn is told to wait, and one that lands just after an answer is
handed that answer back. Refusing them as "already working" only made GPT-Live
retry harder.

The answer does not ride back on the tool call — GPT-Live does not reliably
speak a tool result in this mode, with or without its own `delegationAckFiller`.
The tool call is acknowledged immediately and the agent's reply is pushed into
the live call with `thread/realtime/appendSpeech`, which it does speak.

With the Codex account connection the browser never holds a credential: the
offer/answer exchange goes through the server, which runs
[`CodexVoiceSession`](../../apps/server/src/voice/CodexVoiceSession.ts) against
the user's authenticated Codex install and refuses anything but a ChatGPT login,
so voice cannot silently fall back to a billed API key. Carry the SDP verbatim
over the wire — trimming it strips the CRLF that closes the last line, and the
answering server rejects the body as truncated.

Voice sessions capture from the same `voiceMicrophone` device dictation uses.
