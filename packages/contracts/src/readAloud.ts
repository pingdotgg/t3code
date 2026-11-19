import * as Schema from "effect/Schema";

/**
 * Read aloud on the host: the speech engine of the machine the server runs on, for clients whose
 * browser has no voices (Electron on Linux). Audio plays on that machine, not on the client.
 */
export const ReadAloudEngine = Schema.Literals(["speech-dispatcher", "macos-say", "windows-sapi"]);
export type ReadAloudEngine = typeof ReadAloudEngine.Type;

export const ReadAloudVoice = Schema.Struct({
  /** Pass back as `voice` to speak with it. */
  id: Schema.String,
  name: Schema.String,
  language: Schema.String,
  /** speech-dispatcher's output module (pico, espeak-ng, ...), when there is one. */
  module: Schema.NullOr(Schema.String),
});
export type ReadAloudVoice = typeof ReadAloudVoice.Type;

export const ReadAloudStatus = Schema.Struct({
  engine: Schema.NullOr(ReadAloudEngine),
  voices: Schema.Array(ReadAloudVoice),
  /** Why there is no engine, or how to get better voices. */
  note: Schema.NullOr(Schema.String),
});
export type ReadAloudStatus = typeof ReadAloudStatus.Type;

export const ReadAloudSpeakInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(40_000)),
  /** A voice id from the status; empty uses the engine's default. */
  voice: Schema.String,
  rate: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 2.5 })),
  pitch: Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 1.5 })),
  volume: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type ReadAloudSpeakInput = typeof ReadAloudSpeakInput.Type;

export const ReadAloudSpeakResult = Schema.Struct({
  /** False when a later speak or a stop interrupted it. */
  completed: Schema.Boolean,
});

export class ReadAloudError extends Schema.TaggedError<ReadAloudError>()("ReadAloudError", {
  message: Schema.String,
}) {}
