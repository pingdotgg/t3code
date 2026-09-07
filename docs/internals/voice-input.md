# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Mobile records the audio and transcribes it either locally on supported iOS
devices or through an environment-backed OpenAI service.

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

Environment transcription keeps the OpenAI key on the server. The
[environment transcriber](../../packages/client-runtime/src/voice-input/environmentTranscriber.ts)
mints a short-lived signed URL, uploads the recording, and receives text in the same
request; the server calls OpenAI. Clients only ever see service ids and labels. The
catalog sits behind the `transcription` [environment capability](../../packages/contracts/src/environment.ts),
so older servers offer no environment services. A device's preferred service is stored
per stable `environmentId`, because a service id means nothing outside its environment.
