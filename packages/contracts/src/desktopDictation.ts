import * as Schema from "effect/Schema";

export const DesktopDictationInput = Schema.Struct({
  action: Schema.Literals([
    "status",
    "install",
    "cancel",
    "remove",
    "transcribe",
    "choose-executable",
    "reset-executable",
  ]),
  operationId: Schema.optional(Schema.String),
  audio: Schema.optional(Schema.Uint8Array),
});
export type DesktopDictationInput = typeof DesktopDictationInput.Type;
export const DesktopDictationResult = Schema.Struct({
  state: Schema.Literals([
    "unavailable",
    "missing-model",
    "downloading",
    "ready",
    "transcribing",
    "cancelled",
    "failed",
    "completed",
  ]),
  message: Schema.String,
  downloadedBytes: Schema.Number,
  totalBytes: Schema.Number,
  transcript: Schema.optional(Schema.String),
  executablePath: Schema.optional(Schema.String),
});
export type DesktopDictationResult = typeof DesktopDictationResult.Type;
