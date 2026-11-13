import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";

export const SpeechSynthesisProvider = Schema.Literals(["chatgpt", "xai", "openrouter"]);
export type SpeechSynthesisProvider = typeof SpeechSynthesisProvider.Type;
export const READ_ALOUD_LABELS = {
  off: "Off",
  system: "System voices",
  chatgpt: "ChatGPT Subscription",
  xai: "Grok TTS",
  openrouter: "OpenRouter",
} as const;

export const ReadAloudSettings = Schema.Struct({
  provider: Schema.Literals(["off", "system", "chatgpt", "xai", "openrouter"]),
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
export const SpeechSynthesisRequest = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  model: Schema.String.check(Schema.isMaxLength(160)),
  voice: Schema.String.check(Schema.isMaxLength(160)),
  speed: Schema.Number.check(Schema.isBetween({ minimum: 0.7, maximum: 1.5 })),
  language: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(16)),
});
export type SpeechSynthesisRequest = typeof SpeechSynthesisRequest.Type;
export const SpeechSynthesisCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      voices: Schema.Array(Schema.String),
    }),
  ),
});
export type SpeechSynthesisCatalog = typeof SpeechSynthesisCatalog.Type;

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
      "subscription-login-required",
      "subscription-expired",
      "subscription-unavailable",
    ]),
  },
  { httpApiStatus: 422 },
) {
  override get message() {
    const name = READ_ALOUD_LABELS[this.provider];
    switch (this.reason) {
      case "subscription-login-required":
        return "Sign in to the Codex CLI with ChatGPT on the selected environment. Read aloud uses its native login.";
      case "subscription-expired":
        return "The native Codex login expired. Sign in again on the selected environment.";
      case "subscription-unavailable":
        return "ChatGPT read aloud is unavailable for this account. Check its subscription and workspace permissions.";
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
      case "unavailable":
        return `${name} could not generate speech. Try again later.`;
    }
  }
}
