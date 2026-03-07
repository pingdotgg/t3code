import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerGetCodexRateLimitsInput = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type ServerGetCodexRateLimitsInput = typeof ServerGetCodexRateLimitsInput.Type;

export const ServerCodexRateLimitWindow = Schema.Struct({
  usedPercent: Schema.Number,
  remainingPercent: Schema.Number,
  windowDurationMins: Schema.Int,
  resetsAt: IsoDateTime,
});
export type ServerCodexRateLimitWindow = typeof ServerCodexRateLimitWindow.Type;

export const ServerCodexRateLimitCredits = Schema.Struct({
  hasCredits: Schema.Boolean,
  unlimited: Schema.Boolean,
  balance: Schema.NullOr(Schema.Number),
});
export type ServerCodexRateLimitCredits = typeof ServerCodexRateLimitCredits.Type;

export const ServerCodexRateLimits = Schema.Struct({
  fetchedAt: IsoDateTime,
  limitId: Schema.NullOr(TrimmedNonEmptyString),
  limitName: Schema.NullOr(TrimmedNonEmptyString),
  planType: Schema.NullOr(TrimmedNonEmptyString),
  primary: Schema.NullOr(ServerCodexRateLimitWindow),
  secondary: Schema.NullOr(ServerCodexRateLimitWindow),
  credits: Schema.NullOr(ServerCodexRateLimitCredits),
});
export type ServerCodexRateLimits = typeof ServerCodexRateLimits.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;
