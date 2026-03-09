import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
  homePath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CodexProviderStartOptions = typeof CodexProviderStartOptions.Type;

export const ClaudeCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyStringSchema),
  homePath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ClaudeCodeProviderStartOptions = typeof ClaudeCodeProviderStartOptions.Type;

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  claudeCode: Schema.optional(ClaudeCodeProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;

