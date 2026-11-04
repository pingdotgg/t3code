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

## Live transcription on iOS

When the [live module](../../apps/mobile/modules/t3-voice-transcription/ios/T3VoiceInputModule.swift)
is available, it owns the microphone and streams complete hypotheses into the
captured selection, each replacing the last. Any other change to the draft stops
dictation and keeps what was written. Cancel restores the earlier draft.

One `SpeechAnalyzer` feeds the same audio to `DictationTranscriber`, which gives
fast provisional words, and the newer `SpeechTranscriber`, which corrects them.
The corrected text replaces the matching prefix and the fast tail follows it.
Finish keeps only the newer model's transcript. If live capture can't start
before producing text, the controller falls back to record-then-transcribe.
