import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import { CloudSpeechProvider } from "./speech.ts";
/** Hosted read-aloud APIs. OpenAI is left out: its speech models shut down on 6 January 2027. */
export const CloudSpeechSynthesisProvider = Schema.Literals(["xai", "openrouter", "elevenlabs"]);
export type CloudSpeechSynthesisProvider = typeof CloudSpeechSynthesisProvider.Type;
/** `local` runs a downloaded model on the selected environment; the rest are hosted APIs. */
export const SpeechSynthesisProvider = Schema.Union([
  CloudSpeechSynthesisProvider,
  Schema.Literal("local"),
]);
export type SpeechSynthesisProvider = typeof SpeechSynthesisProvider.Type;
export const READ_ALOUD_LABELS = {
  off: "Off",
  system: "System voices",
  local: "Local model",
  xai: "Grok TTS",
  openrouter: "OpenRouter",
  elevenlabs: "ElevenLabs",
} as const;

export const ReadAloudSettings = Schema.Struct({
  provider: Schema.Literals([
    "off",
    "system",
    "local",
    "openai",
    "chatgpt",
    "xai",
    "openrouter",
    "elevenlabs",
  ]).pipe(
    Schema.decodeTo(
      Schema.Literals(["off", "system", "local", "xai", "openrouter", "elevenlabs"]),
      SchemaTransformation.transform({
        decode: (value) => (value === "chatgpt" || value === "openai" ? ("off" as const) : value),
        encode: (value) => value,
      }),
    ),
  ),
  environmentId: Schema.NullOr(EnvironmentId),
  model: Schema.String.check(Schema.isMaxLength(160)),
  voice: Schema.String.check(Schema.isMaxLength(160)),
  speed: Schema.Number.check(Schema.isBetween({ minimum: 0.7, maximum: 1.5 })),
  language: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(16)),
  skipCodeBlocks: Schema.Boolean,
  backgroundPlayback: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ReadAloudSettings = typeof ReadAloudSettings.Type;
/** The speeds clients offer, within the settings' range. */
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5] as const;
export const DEFAULT_READ_ALOUD_SETTINGS: ReadAloudSettings = {
  provider: "off",
  environmentId: null,
  model: "",
  voice: "",
  speed: 1,
  language: "auto",
  skipCodeBlocks: true,
  backgroundPlayback: true,
};
export const ReadAloudPreference = ReadAloudSettings.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_READ_ALOUD_SETTINGS)),
);
/** The environment splits longer text for providers with smaller input limits. */
export const SPEECH_SYNTHESIS_MAX_TEXT = 32_000;
/** Serves a started synthesis as one MP3 stream that native players read while it is produced. */
export const SPEECH_SYNTHESIS_AUDIO_PATH = "/api/voice/synthesis/audio";
export const SpeechSynthesisRequest = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SPEECH_SYNTHESIS_MAX_TEXT)),
  model: Schema.String.check(Schema.isMaxLength(160)),
  voice: Schema.String.check(Schema.isMaxLength(160)),
  speed: Schema.Number.check(Schema.isBetween({ minimum: 0.7, maximum: 1.5 })),
  language: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(16)),
  /**
   * UTF-16 offset of the word the audio starts at. The text before it is still synthesized, so a
   * voice picking up mid-sentence reads in context; its audio and timings are dropped.
   */
  from: Schema.optionalKey(NonNegativeInt),
});
export type SpeechSynthesisRequest = typeof SpeechSynthesisRequest.Type;
/** Single-purpose credential for `SPEECH_SYNTHESIS_AUDIO_PATH`, so media elements need no headers. */
export const SpeechSynthesisStream = Schema.Struct({ token: Schema.String });
/**
 * Where a provider's word timings come from: `provider` timestamps from its API, `boundary`
 * events from a platform voice, or an `estimated` spread of the text over the audio.
 */
export const ReadAloudWordTimings = Schema.Literals(["provider", "boundary", "estimated"]);
export type ReadAloudWordTimings = typeof ReadAloudWordTimings.Type;
/** A spoken word: UTF-16 offsets in the request text and seconds into its audio. */
export const SpeechSynthesisWord = Schema.Struct({
  start: Schema.Int,
  end: Schema.Int,
  startSeconds: Schema.Finite,
  endSeconds: Schema.Finite,
});
export type SpeechSynthesisWord = typeof SpeechSynthesisWord.Type;
/** How loud the audio is around `seconds` into it, from 0 (silence) to 1. */
export const SpeechSynthesisLevel = Schema.Struct({
  seconds: Schema.Finite,
  level: Schema.Finite,
});
export type SpeechSynthesisLevel = typeof SpeechSynthesisLevel.Type;
/**
 * Reads the word timings of a started synthesis after the first `after` words. `levelsAfter` also
 * reads its loudness after that many levels, for players that cannot measure the audio they play.
 */
export const SpeechSynthesisTimingsRequest = Schema.Struct({
  token: Schema.String,
  after: NonNegativeInt,
  levelsAfter: Schema.optionalKey(NonNegativeInt),
});
/**
 * Answers once new words, or new levels when asked for, exist or synthesis ends;
 * `durationSeconds` comes with the end. Levels exist only for audio the environment decodes.
 */
export const SpeechSynthesisTimings = Schema.Struct({
  words: Schema.Array(SpeechSynthesisWord),
  levels: Schema.optionalKey(Schema.Array(SpeechSynthesisLevel)),
  done: Schema.Boolean,
  durationSeconds: Schema.optionalKey(Schema.Finite),
});
export type SpeechSynthesisTimings = typeof SpeechSynthesisTimings.Type;
/** A reply's formulas as TeX, each set as a block (`display`) or inline, to be read as words. */
export const SpeechMathRequest = Schema.Struct({
  formulas: Schema.Array(
    Schema.Struct({
      tex: Schema.String.check(Schema.isMaxLength(SPEECH_SYNTHESIS_MAX_TEXT)),
      display: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(1_000)),
  /** The app's language; formulas are read in English where the environment has no rules for it. */
  language: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(16)),
});
/** The words for each formula, in order, as screen readers say them; null for one read as its TeX. */
export const SpeechMath = Schema.Struct({ words: Schema.Array(Schema.NullOr(Schema.String)) });
export type SpeechMath = typeof SpeechMath.Type;
export const SpeechSynthesisModelInstall = Schema.Struct({
  state: Schema.Literals(["downloadable", "downloading", "verifying", "installed"]),
  /** Bytes to download, including the speech runtime when this environment lacks it. */
  size: Schema.Finite,
  downloaded: Schema.optionalKey(Schema.Finite),
  /** The environment's own file an installed model uses; only filesystem readers see it. */
  linkedFrom: Schema.optionalKey(Schema.String),
});
export type SpeechSynthesisModelInstall = typeof SpeechSynthesisModelInstall.Type;
/** The local model that times the words of speech whose provider reports none. */
export const WORD_TIMING_MODEL_ID = "word-timing";
/** An empty model loads the environment's default local model. */
export const SpeechSynthesisPrepareRequest = Schema.Struct({
  model: Schema.String.check(Schema.isMaxLength(160)),
});
export const SpeechSynthesisModelRequest = Schema.Struct({
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
});
export const SpeechSynthesisCatalog = Schema.Struct({
  defaultModel: Schema.String,
  apiKeyProvider: Schema.NullOr(CloudSpeechProvider),
  supportsModelSelection: Schema.Boolean,
  supportsVoiceSelection: Schema.Boolean,
  speedAppliedByProvider: Schema.Boolean,
  /** Absent when the timings are `estimated`. */
  wordTimings: Schema.optionalKey(ReadAloudWordTimings),
  /**
   * Present when the words are estimated and this environment can time them instead, once
   * `WORD_TIMING_MODEL_ID` is downloaded like a local model.
   */
  wordTimingModel: Schema.optionalKey(SpeechSynthesisModelInstall),
  error: Schema.optionalKey(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      voices: Schema.Array(Schema.String),
      /** Display names for voices whose ids are opaque. */
      voiceNames: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      /** The languages a model speaks, as ISO 639-1 codes, when its provider says. */
      languages: Schema.optionalKey(Schema.Array(Schema.String)),
      recommended: Schema.optionalKey(Schema.Boolean),
      /** Present for models that run on the environment and must be downloaded first. */
      install: Schema.optionalKey(SpeechSynthesisModelInstall),
      /** Overrides the catalog's `speedAppliedByProvider` for this model. */
      speedAppliedByProvider: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type SpeechSynthesisCatalog = typeof SpeechSynthesisCatalog.Type;

/** Whether synthesis already honors the speed setting; otherwise players speed up playback. */
export const speechSpeedAppliedByProvider = (catalog: SpeechSynthesisCatalog, model: string) =>
  catalog.models.find((entry) => entry.id === model)?.speedAppliedByProvider ??
  catalog.speedAppliedByProvider;

export const EMPTY_SPEECH_SYNTHESIS_CATALOG: SpeechSynthesisCatalog = {
  defaultModel: "",
  apiKeyProvider: null,
  supportsModelSelection: false,
  supportsVoiceSelection: false,
  speedAppliedByProvider: false,
  models: [],
};

export class SpeechSynthesisError extends Schema.TaggedError<SpeechSynthesisError>()(
  "SpeechSynthesisError",
  {
    provider: SpeechSynthesisProvider,
    cause: Schema.optionalKey(Schema.Defect()),
    reason: Schema.Literals([
      "missing-key",
      "key-changed",
      "unreadable-key",
      "rejected-key",
      "rate-limit",
      "unavailable",
      "model-unavailable",
      "missing-model",
    ]),
  },
  { httpApiStatus: 422 },
) {
  override get message() {
    const name = READ_ALOUD_LABELS[this.provider];
    switch (this.reason) {
      case "missing-key":
        return `Add your ${name} API key in Settings → Voice.`;
      case "unreadable-key":
        return `Unlock the API key vault on the selected environment. No text was sent to ${name}.`;
      case "key-changed":
        return `The ${name} API key changed. Start reading again.`;
      case "rejected-key":
        return `${name} rejected the API key. Check its permissions and billing.`;
      case "rate-limit":
        return `${name} reached a usage limit. Try again later.`;
      case "model-unavailable":
        return `Choose an available ${name} speech model in Settings → Voice.`;
      case "missing-model":
        return "Download a local speech model in Settings → Voice.";
      case "unavailable":
        return `${name} could not generate speech. Try again later.`;
    }
  }
}
