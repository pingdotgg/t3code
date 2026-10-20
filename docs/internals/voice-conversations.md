# Voice conversations

A voice conversation is a Codex realtime session bound to one thread. The user
talks to a voice model, and when it wants work done it starts an ordinary Codex
turn on that thread. This is separate from [voice input](voice-input.md), which
only transcribes into the composer.

Audio never touches the T3 socket. The client owns the microphone, speaker, and
WebRTC peer, and audio flows directly between the client and OpenAI. The
`provider.voice.session` stream carries only the SDP handshake, captions, and
lifecycle. That keeps remote and tunneled clients as cheap as local ones, and it
is why the [shared controller](../../packages/client-runtime/src/voice-mode/controller.ts)
takes a platform object: browsers and react-native-webrtc supply the same peer API.

The stream's lifetime is the conversation's lifetime. When the client
unsubscribes or disconnects, the server stops the realtime session, so a dropped
client cannot leave a billed session running.

Handoffs are client-managed, as in the Codex TUI. The
[Codex voice module](../../apps/server/src/provider/Layers/CodexVoice.ts) hands
each voice turn's final answer back with `thread/realtime/appendSpeech`, which
keeps commentary and reasoning unspoken.

Codex starts or steers the delegated turn itself, with a user message wrapped in
`<realtime_delegation>`, and it cannot be told not to. Steering an active run
needs nothing special. An idle thread is different: V2 runs are
orchestrator-owned and there is no provider-initiated run yet, so
[CodexAdapterV2](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)
interrupts that turn and, once it settles, offers a `voice` continuation. The
request then runs as an ordinary user message, and Codex's history keeps a stub
of the interrupted turn. Captions are ephemeral and are not persisted.

A thread needs an existing provider session binding before voice can start,
because Codex attaches realtime to an existing provider thread.
