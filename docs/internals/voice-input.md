# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Mobile defaults to on-device transcription; any client that sends audio off
the device needs a grant for one environment.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. A
transcriber may expose a streaming session, in which case audio leaves during
capture and `finish` replaces the file-based `transcribe`.

## Where audio may go

Only an explicit audio grant authorizes off-device transcription. On mobile the
grant is stored in device-bound secure storage, outside preference backups. The
recorder is the same for both destinations; only a finished recording can be
uploaded, and its grant is checked again after native decoding and before dispatch.
The [web grant](../../apps/web/src/speech/voiceConsent.ts) lives outside the preferences snapshot so another
window saving unrelated settings cannot resurrect a revoked grant. Each new
choice gets a distinct grant, even if the destination was previously selected. The
[web hook](../../apps/web/src/speech/useEnvironmentSpeechInput.ts) binds a
recording controller to the prepared connection of that destination and to
nothing else. When the destination changes, disconnects, or stops advertising the
`voiceTranscription` capability, the controller is disposed: a recording in
progress is discarded, a failed recording kept for retry is deleted, and nothing
falls back to another environment. Every sender in the web app, including the
settings page's transcription test, goes through that hook. The microphone loopback
test captures separately for local playback and sends nothing. The transport
refuses redirects so credentials and audio cannot follow one to another host.

Transcript cleanup requires its own grant, off by default.
It sends text, never audio, to the text generation provider of the draft's
own environment, because that is where the provider credentials live. A later
backend adds its own destination kind, disclosure, and transcriber; capture and
the controller stay as they are.

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
