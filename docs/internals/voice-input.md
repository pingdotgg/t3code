# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. The current implementation transcribes locally on supported iOS devices;
environment-backed transcription is not implemented.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Live transcription owns microphone capture and streams complete hypotheses into
the captured selection. Each hypothesis replaces the preceding one. The client
acknowledges these writes synchronously because native events can arrive before
React renders; unrelated text or ownership changes invalidate the session.

React Native iOS uses `DictationTranscriber` with progressive long dictation for
frequent word updates and corrections. Preparation resolves and downloads that
engine's language assets before microphone capture begins.

Cancellation invalidates results immediately, but resources stay owned until
native work settles. Preparation and finalization must finish or cancel before
another composer can acquire the audio session. The file-based transcription
contract remains available for clients without streaming capture.
