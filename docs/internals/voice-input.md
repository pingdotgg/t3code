# Voice input

Voice input edits a draft in the composer or a supported text editor and never
submits it automatically. The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
binds a recording to its transcriber and resolved locale. Draft ownership, text,
revision, and selection are captured before recording and checked before insertion,
so a late transcript cannot overwrite a draft that was edited or replaced.

## Environment boundaries

Supported iOS devices transcribe locally through the
[Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts).
Web and desktop capture audio on the client and send it through the authenticated
connection to the selected transcription environment, where transcribe.cpp runs.
The transcription host can differ from the thread's environment, even when the
desktop app has a bundled server.

Microphone selection and personal dictation preferences are client-local. Each
recording snapshots those preferences and the originating project's vocabulary.
Project vocabulary uses project overrides on the originating environment; the
transcription host never stores foreign project IDs. The resolved dictionary and
correction cue travel with both transcription and cleanup requests. Cleanup runs
on the thread's environment, where its provider model and credentials live, and
sends the transcript and draft context to that provider.

Model storage and lifecycle belong to the transcription environment. It advertises
the `voiceTranscription` capability so newer clients do not probe older servers.
See the [client integration](../../apps/web/src/speech/useEnvironmentSpeechInput.ts)
for host selection and preference snapshots, and the
[speech service](../../apps/server/src/speech/SpeechService.ts) for model lifecycle.
Transcription options travel in request bodies or the stream's initial command,
rather than URLs or headers; the [wire encoding](../../packages/shared/src/speech.ts)
and [stream contracts](../../packages/contracts/src/speech.ts) define those formats.

## Cancellation and resource ownership

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

Web and desktop cancellation aborts the client request and prevents late transcript
insertion. Editors remain read-only and submission stays disabled while voice input
is busy, but draft revision checks still protect against external changes.
