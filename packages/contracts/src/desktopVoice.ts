import * as Schema from "effect/Schema";

export const DesktopVoiceTranscript = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(120_000)),
  locale: Schema.String,
});
export type DesktopVoiceTranscript = typeof DesktopVoiceTranscript.Type;

export const DesktopVoiceRequest = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/));
