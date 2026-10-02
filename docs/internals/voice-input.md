# Voice input

Voice input edits the current composer draft and never submits a turn automatically.
The shared `VoiceInputController` in `packages/client-runtime` owns preparation,
recording, cancellation, draft revision checks, cleanup, and transcript insertion.
Clients supply recorder and transcriber implementations.

## Implementations

- iOS 26 and newer records and transcribes on the device with Apple's
  `SpeechAnalyzer` and `SpeechTranscriber`.
- Web and desktop record with browser media APIs. The client converts the
  recording to 16 kHz mono Float32 PCM and sends it through the authenticated
  connection to the selected transcription environment.
- The environment runs the selected transcription model through transcribe.cpp
  and returns only transcript text. Users manage model downloads and selection in
  Settings > Voice.

The desktop app normally connects to its bundled server, so capture and
transcription stay on the same computer. A client connected to a remote
environment sends microphone audio to that machine. The UI describes this as
transcription on the T3 environment rather than on-device transcription.

## Boundaries

Microphone selection and personal dictation preferences are client-local. Each
recording snapshots those preferences and the originating project's vocabulary.
Project vocabulary uses project overrides on the originating environment; the
transcription host never stores foreign project IDs. The resolved dictionary and
correction cue travel with both transcription and cleanup requests. Cleanup runs
on the thread's environment, where its provider model and credentials live.
Model storage and lifecycle belong to the transcription environment because that
is where transcribe.cpp runs. The environment advertises the `voiceTranscription`
capability so newer clients do not probe older servers.

Batch audio uses a bounded binary HTTP request: a four-byte little-endian JSON
length, UTF-8 transcription options, then unencoded PCM. Streaming sends options
in its initial `start` command before any audio. Preferences stay in request
bodies rather than URLs or headers. Cancellation
aborts the client request and prevents late transcript insertion. Model-load
failures are not cached, so later attempts can retry. The server accepts at most
five minutes of 16 kHz mono Float32 PCM per request.

The controller captures draft ownership, revision, text, and selection before
recording. The composer remains read-only and submission stays disabled until
the operation finishes or is discarded.
