import * as Schema from "effect/Schema";
import { RunId, ThreadId } from "./baseSchemas.ts";
import { SpeechStreamText, SpeechTranscriptionOptions } from "./speech.ts";

// Mic: binary 16 kHz Float32 PCM, at most 1 s a frame, unacknowledged; the server reads only
// as fast as it transcribes, so bound the queue with `bufferedAmount`. Voice: binary
// `encodeSpeechAudioFrame` frames of at most 0.5 s. Closes 1000 after stop/idle, 1008 after error.
export const VOICE_CONVERSATION_PATH = "/ws/voice/conversation";

/** A Kokoro voice id, such as `af_heart`. An unknown id falls back to the default voice. */
export const VoiceTtsVoice = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
export type VoiceTtsVoice = typeof VoiceTtsVoice.Type;

/** How long the mic may hear no speech before the call ends with `idle`, measured in audio. */
export const VoiceIdleTimeout = Schema.Literals(["min_5", "min_10", "min_30", "never"]);
export type VoiceIdleTimeout = typeof VoiceIdleTimeout.Type;

const TurnPauseMs = Schema.Int.check(Schema.isBetween({ minimum: 300, maximum: 10_000 }));

export const VoiceConversationOptions = Schema.Struct({
  transcription: SpeechTranscriptionOptions,
  voice: Schema.optionalKey(VoiceTtsVoice),
  /** Default `min_10`. */
  idleTimeout: Schema.optionalKey(VoiceIdleTimeout),
  /** Pause that ends a turn. Server default 1500 ms. */
  endSilenceMs: Schema.optionalKey(TurnPauseMs),
  /** Pause that ends a turn whose text reads as unfinished. Server default 3000 ms. */
  endSilenceLongMs: Schema.optionalKey(TurnPauseMs),
  /** Recorded on the messages the call sends to the thread. */
  source: Schema.Literals(["web", "mobile"]),
});
export type VoiceConversationOptions = typeof VoiceConversationOptions.Type;

export const VoiceConversationCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    threadId: ThreadId,
    options: VoiceConversationOptions,
  }),
  /**
   * Playback cursor: `sample` samples of `seq` have played, counted from that seq's start at
   * its `speak` sample rate. Send one after each frame finishes playing; the call leaves
   * `speaking` only once the cursor reaches the end of its audio.
   */
  Schema.Struct({
    type: Schema.Literal("played"),
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    sample: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  /** Keep streaming mic frames while muted: they count toward the idle timeout unheard. */
  Schema.Struct({ type: Schema.Literal("mute") }),
  Schema.Struct({ type: Schema.Literal("unmute") }),
  Schema.Struct({ type: Schema.Literal("stop") }),
]);
export type VoiceConversationCommand = typeof VoiceConversationCommand.Type;

// First that applies: `speaking` while voice audio is queued, rendering, or not yet acked as
// played (leaving it is the "done speaking" signal); `thinking` while answering or reading
// back a run; `delegated` while a run the call started works; else `listening`.
export const VoiceConversationState = Schema.Literals([
  "listening",
  "thinking",
  "speaking",
  "delegated",
]);
export type VoiceConversationState = typeof VoiceConversationState.Type;

export const VoiceConversationEvent = Schema.Union([
  /** The models are loaded and the mic is heard from here on. */
  Schema.Struct({ type: Schema.Literal("ready") }),
  /**
   * Replaces the speaker's previous caption. A new user utterance or a new `speak`
   * starts again from empty text.
   */
  Schema.Struct({
    type: Schema.Literal("caption"),
    who: Schema.Literals(["you", "voice"]),
    ...SpeechStreamText.fields,
  }),
  Schema.Struct({ type: Schema.Literal("state"), state: VoiceConversationState }),
  /** Binary frames for this seq follow. Seqs play in order. */
  Schema.Struct({
    type: Schema.Literal("speak"),
    seq: Schema.Int,
    text: Schema.String,
    sampleRate: Schema.Int,
  }),
  /** Drop this seq's audio and every earlier seq's, including anything already buffered. */
  Schema.Struct({ type: Schema.Literal("cut"), seq: Schema.Int }),
  /** The call sent `text` to the thread, which is running it as `runId`. */
  Schema.Struct({ type: Schema.Literal("delegated"), runId: RunId, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type VoiceConversationEvent = typeof VoiceConversationEvent.Type;
