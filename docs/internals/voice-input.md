# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text to the agent. Mobile defaults to on-device transcription. Sending audio off
the device requires an explicit grant naming one environment and, for cloud
transcription, one provider.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion. A
transcript is dropped only when its draft is gone or belongs to another owner. In a
draft that was edited, the recorded caret means nothing, so the words go at its end. A
transcriber may expose a streaming session, in which case audio leaves during
capture and `finish` replaces the file-based `transcribe`.

Recordings outlive their dictation. The controller hands the file to `keepRecording`
as soon as the recorder stops, before transcription, and cleanup never deletes it.
Whatever goes wrong afterwards (a thrown transcription, an empty result, a dropped
transcript, words the voice filter removed) is then recoverable: `retranscribe` runs
the latest file again, and mobile Settings runs any of the last few without the
voice filter. Mobile keeps several, not one, because the next recording is often the
user trying again, and it must not destroy the one they want back. Web supplies no
`keepRecording`; it sets `retryFailedRecording` and retries a failed file on the next start.

## Where audio may go

On mobile, on-device transcription needs no audio grant. Environment and cloud
transcription share a recorder and upload only finished recordings. The client
keeps the grant in device-bound secure storage, outside preference backups, and
rechecks it after native decoding and before upload.

The macOS desktop app adds a `device` destination, Apple Speech. It exists only in
the web grant schema, not in `VoiceTranscriptionDestination`, because no environment
or other client can act on it. The desktop main process runs a
[Swift helper](../../native/apple-speech/AppleSpeech.swift) that the macOS release
runners compile; the Speech framework exists only in the macOS SDK.

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
It sends text, never audio, to the text generation model of the draft's
own environment, because that is where its credentials live.

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
A model file from another app is installed as a symlink only after its SHA-256
matches a catalog entry, so the store never loads a file the catalog does not pin
and removing a model never deletes a file T3 Code did not download.

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

## On-device models (PseudoCode)

The fork swaps the transcriber handed to the controller: the
[dictation transcriber](../../apps/mobile/src/features/dictation/dictationTranscriber.ts) wraps
the system one and runs a downloaded model through the
[native module](../../apps/mobile/modules/pseudo-dictation). Fork code stays in
`features/dictation`, `modules/pseudo-dictation` and `plugins/withDictationPods.cjs`. Upstream
files only import from them, at the end of their import block, so upstream merges stay small.
An environment or cloud grant replaces the on-device path entirely, so the model, voice filter
and corrections apply only when Settings → Voice transcribes on this device.

- The controller awaits preparation before it records, so preparation never waits on a model,
  Apple's included. The model loads while the user talks, and the system recognizer stands in for
  a model that is missing, still compiling, or failed on the recording. A language Apple cannot
  take is therefore known only when the recording is transcribed.
- expo-audio pauses the recorder for an audio-session interruption without an event, and resumes
  it only if the system later says capture may continue. The metering loop notices that capture
  stopped, and the controller transcribes the captured file at once instead of waiting. That file
  wins over the recorder's current one, because a media-services reset hands the recorder a new,
  empty file.
- At the five-minute limit the recorder stops just before it reports that it finished. A stop in
  the last second is therefore treated as the limit, not as an interruption.
- FluidAudio is a git pod pinned to a commit and added by the config plugin to the app target
  only. The widget extension must not link it.
- The engine reaches the network only inside an explicit download.
- The voice filter never runs on the GPU, because iOS refuses GPU work in the background, where a
  dictation may finish.
- The thresholds in [SpeakerFilter](../../apps/mobile/modules/pseudo-dictation/ios/Core/SpeakerFilter.swift)
  come from measurement and lean towards keeping a stranger's words over cutting the user's. A
  voiceprint alone cut the user's own words in long dictations, so a turn is cut only when it is
  also clearly quieter than the user. Loudness is a heuristic, not identity: a voice as loud as
  the user's stays.
  `RealVoiceTests` measures them on recordings of real people; rerun it before changing one.
- `ios/Core` builds as a Swift package on macOS so `swift test` covers it without a simulator.
  The Expo module file is outside that package and compiles only in an iOS build.
