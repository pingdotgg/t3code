# Voice input

> For maintainers. Using T3 Code? See [voice input on iPhone](../user/composer.md#voice-input-on-iphone).

Voice input produces editable composer text. The current implementation records on the client and
transcribes locally with Apple's `SpeechAnalyzer` and `SpeechTranscriber` on supported iOS 26+
devices. Environment-provided transcription and transcription on web and desktop are not implemented.

## Current boundaries

[`VoiceInputController`][controller] owns preparation, recording, transcription, cancellation,
temporary-file cleanup, and insertion into the captured draft selection. Its dependencies separate
the recorder from the functions that prepare transcription and transcribe a recording. The
controller imports neither React Native nor an Apple transcription API.

[`useVoiceInputController`][hook] supplies Expo audio capture, microphone permissions, audio-session
management, waveform samples, and the local transcription binding. [`voiceTranscription.ios.ts`][ios]
adapts `@react-native-ai/apple`, including locale preparation and error translation. The other-platform
binding reports local transcription as unavailable. That result describes the local implementation,
not whether a client could use an environment's transcription service.

The composer renders recording state and edits draft text without selecting a speech vendor.
Recording captures the draft owner, revision, text, and selection. A late transcript cannot overwrite
a different or edited draft. Only normal message submission sends the resulting text to an agent.

Cancellation invalidates the operation immediately. The current native binding cannot abort an
in-flight transcription, so the controller retains its session until that work settles, ignores its
result, and cleans up the recording.

## Ownership decisions

The extension boundary distinguishes transcription on the client device from transcription through
the composer's environment. These constraints apply when adding selectable transcription services:

- Local means the client device, regardless of which machine hosts the environment. A device's lack
  of local recognition does not prevent it from recording audio for an environment service.
- Remote service configuration and API keys belong to the environment. The environment calls the
  external service. Clients receive service identifiers, labels, and availability information, never
  credential values. Transcription services are independent of coding-agent `providerInstances`;
  selecting OpenAI for transcription does not select Codex for the thread.
- The client owns its transcription preference, scoped by stable `environmentId`. Its choices are
  supported local recognition and the services exposed by the composer's environment. A service ID
  is meaningful only within that environment. Different clients can make different choices.
- Resolve and capture the environment, selected service, and locale when an operation starts.
  Preparation and transcription use the same selection; preference changes affect the next
  recording. Capture environment identity explicitly rather than recovering it from a draft key.
  Keep the existing draft-owner and revision checks before inserting text.
- If the selected option is unavailable, report that state and let the user choose another option.
  A local failure must not silently upload audio, and a disconnected environment must not redirect
  a recording to another environment or service.
- Transcription audio is temporary input, separate from durable chat attachments and messages.
  Remote adapters need cancellation of upload and transcription where supported, cleanup after
  success, failure, or cancellation, and the same protection against late results as local transcription.

## Existing integration points

[`ServerSettingsService`][settings] and [`ServerSecretStore`][secrets] provide environment-owned
configuration and secret persistence. Existing settings redaction handles coding-provider environment
variables only. Any transcription credential fields need their own explicit separation and redaction
before settings responses or subscriptions reach client caches.

[`ExecutionEnvironmentCapabilities`][capabilities] handles version skew. Remote transcription must be
opt-in: a missing transcription capability means unsupported. The authenticated server-config
subscription and [shared environment state][server-state] already distribute configuration per
environment. A transcription service catalog belongs behind that capability and authenticated
boundary. Older servers expose no remote transcription choices.

The [attachment upload contracts][uploads] and [shared upload operations][attachment-state] provide a
pattern for authorized binary uploads through an environment, including remote connections. Their
existing chat-attachment retention is not a transcription cleanup policy.

Shared service selection and environment requests belong in `packages/client-runtime`, with wire
contracts in `packages/contracts`. Capture and native local recognition remain client-specific. The
current injected transcription functions provide the boundary for the local release; introducing a
second implementation is the point to bind preparation and transcription into a selected session.

[controller]: ../../apps/mobile/src/features/voice-input/voiceInputController.ts
[hook]: ../../apps/mobile/src/features/voice-input/useVoiceInputController.ts
[ios]: ../../apps/mobile/src/native/voiceTranscription.ios.ts
[settings]: ../../apps/server/src/serverSettings.ts
[secrets]: ../../apps/server/src/auth/ServerSecretStore.ts
[capabilities]: ../../packages/contracts/src/environment.ts
[server-state]: ../../packages/client-runtime/src/state/server.ts
[uploads]: ../../packages/contracts/src/assets.ts
[attachment-state]: ../../packages/client-runtime/src/state/attachments.ts
