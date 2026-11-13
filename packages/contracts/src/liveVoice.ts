import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const LiveVoiceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
export const LiveVoiceOptions = Schema.Struct({
  voices: Schema.Array(Schema.String),
  defaultVoice: Schema.String,
});
export type LiveVoiceOptions = typeof LiveVoiceOptions.Type;
export const LiveVoiceStart = Schema.Struct({
  threadId: ThreadId,
  sessionId: LiveVoiceId,
  voice: LiveVoiceId,
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262144)),
});
export type LiveVoiceStart = typeof LiveVoiceStart.Type;
export const LiveVoiceTranscript = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});
export type LiveVoiceTranscript = typeof LiveVoiceTranscript.Type;
export const LiveVoiceState = Schema.Struct({
  revision: Schema.Number,
  phase: Schema.Literals(["connected", "ended", "error"]),
  transcripts: Schema.Array(LiveVoiceTranscript),
  error: Schema.NullOr(Schema.String),
});
export type LiveVoiceState = typeof LiveVoiceState.Type;
export class LiveVoiceError extends Schema.TaggedError<LiveVoiceError>()("LiveVoiceError", {
  reason: Schema.Literals([
    "unavailable",
    "authentication",
    "unsupported",
    "connection",
    "busy",
    "expired",
    "thread-changed",
  ]),
  status: Schema.optionalKey(Schema.Number),
}) {
  override get message() {
    switch (this.reason) {
      case "authentication":
        return "Live voice requires the ChatGPT account connected to this provider. Reconnect it in provider settings.";
      case "unsupported":
        return "This account connection or Codex version does not support subscription voice.";
      case "connection":
        return `The subscription voice service could not connect${this.status ? ` (HTTP ${this.status})` : ""}. No API-key fallback was used.`;
      case "busy":
        return "This conversation already has an active voice session.";
      case "expired":
        return "The voice session has ended. Start a new session.";
      case "thread-changed":
        return "The conversation or account changed. Start voice again to use the current connection.";
      default:
        return "Live voice is available in saved Codex conversations with a connected ChatGPT account.";
    }
  }
}
