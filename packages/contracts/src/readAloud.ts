import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { EnvironmentId } from "./baseSchemas.ts";
import { CloudSpeechProvider } from "./speech.ts";

/** `local` runs a downloaded model on the selected environment; the rest are hosted APIs. */
export const SpeechSynthesisProvider = Schema.Union([CloudSpeechProvider, Schema.Literal("local")]);
export type SpeechSynthesisProvider = typeof SpeechSynthesisProvider.Type;
export const READ_ALOUD_LABELS = {
  off: "Off",
  system: "System voices",
  local: "Local model",
  openai: "OpenAI",
  xai: "Grok TTS",
  openrouter: "OpenRouter",
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
  ]).pipe(
    Schema.decodeTo(
      Schema.Literals(["off", "system", "local", "openai", "xai", "openrouter"]),
      SchemaTransformation.transform({
        decode: (value) => (value === "chatgpt" ? ("off" as const) : value),
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
});
export type SpeechSynthesisRequest = typeof SpeechSynthesisRequest.Type;
/** Single-purpose credential for `SPEECH_SYNTHESIS_AUDIO_PATH`, so media elements need no headers. */
export const SpeechSynthesisStream = Schema.Struct({ token: Schema.String });
export const SpeechSynthesisModelInstall = Schema.Struct({
  state: Schema.Literals(["downloadable", "downloading", "verifying", "installed"]),
  /** Bytes to download, including the speech runtime when this environment lacks it. */
  size: Schema.Finite,
  downloaded: Schema.optionalKey(Schema.Finite),
  /** The environment's own file an installed model uses; only filesystem readers see it. */
  linkedFrom: Schema.optionalKey(Schema.String),
});
export type SpeechSynthesisModelInstall = typeof SpeechSynthesisModelInstall.Type;
export const SpeechSynthesisModelRequest = Schema.Struct({
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
});
export const SpeechSynthesisCatalog = Schema.Struct({
  defaultModel: Schema.String,
  apiKeyProvider: Schema.NullOr(CloudSpeechProvider),
  supportsModelSelection: Schema.Boolean,
  supportsVoiceSelection: Schema.Boolean,
  speedAppliedByProvider: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      voices: Schema.Array(Schema.String),
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
