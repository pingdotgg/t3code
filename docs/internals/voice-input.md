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
  environment HTTP connection.
- The environment downloads and verifies Moonshine Streaming Tiny on first use,
  runs it through transcribe.cpp, and returns only transcript text.

The desktop app normally connects to its bundled server, so capture and
transcription stay on the same computer. A client connected to a remote
environment sends microphone audio to that machine. The UI describes this as
transcription on the T3 environment rather than on-device transcription.

## Boundaries

Microphone selection is client-local because input devices belong to the client.
Model storage and lifecycle belong to the environment because that is where
transcribe.cpp runs. The environment advertises the `voiceTranscription`
capability so newer clients do not probe older servers.

Audio uses a bounded binary HTTP request rather than JSON or base64. Cancellation
aborts the client request and prevents late transcript insertion. Model-load
failures are not cached, so later attempts can retry. The server accepts at most
five minutes of 16 kHz mono Float32 PCM per request.

The controller captures draft ownership, revision, text, and selection before
recording. The composer remains read-only and submission stays disabled until
the operation finishes or is discarded.
