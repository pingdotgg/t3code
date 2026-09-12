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

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

Mobile's `VoiceInputProvider` keeps one recorder and `VoiceInputSession` above navigation.
The session owns the original draft key and writes through the composer draft store even
when its screen is unmounted. It observes draft edits to reject stale transcripts.
Navigation and app backgrounding preserve active capture; backgrounding still cancels
preparation. iOS background audio mode and Expo background recording keep capture active.
Waveform sampling runs only for a focused, foreground composer.

Cleanup tolerates unavailable native recorder properties and releases the audio session
and recording lock even if Expo has already released the recorder.
