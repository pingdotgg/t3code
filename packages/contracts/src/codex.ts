import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const CodexSetOpenAiEnvInput = Schema.Struct({
  openaiApiKey: Schema.NullOr(TrimmedNonEmptyString),
  openaiBaseUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type CodexSetOpenAiEnvInput = typeof CodexSetOpenAiEnvInput.Type;

export const CodexSetOpenAiEnvResult = Schema.Struct({
  openaiApiKeySet: Schema.Boolean,
  openaiBaseUrl: Schema.NullOr(TrimmedNonEmptyString),
});
export type CodexSetOpenAiEnvResult = typeof CodexSetOpenAiEnvResult.Type;
