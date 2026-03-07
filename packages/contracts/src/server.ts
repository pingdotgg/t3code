import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { CODEX_REASONING_EFFORT_OPTIONS } from "./model";
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
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const ServerCopilotUsageSource = Schema.Literal("copilot_internal_user");
export type ServerCopilotUsageSource = typeof ServerCopilotUsageSource.Type;

const ServerCopilotUsageAvailable = Schema.Struct({
  status: Schema.Literal("available"),
  source: ServerCopilotUsageSource,
  fetchedAt: IsoDateTime,
  login: TrimmedNonEmptyString,
  plan: Schema.optional(TrimmedNonEmptyString),
  entitlement: NonNegativeNumber,
  remaining: NonNegativeNumber,
  used: NonNegativeNumber,
  percentRemaining: Schema.Number,
  overagePermitted: Schema.Boolean,
  overageCount: NonNegativeNumber,
  unlimited: Schema.Boolean,
  resetAt: IsoDateTime,
});

const ServerCopilotUsageUnavailable = Schema.Struct({
  status: Schema.Literals(["requires-auth", "unavailable"]),
  fetchedAt: IsoDateTime,
  source: Schema.optional(ServerCopilotUsageSource),
  message: TrimmedNonEmptyString,
});

export const ServerCopilotUsage = Schema.Union([
  ServerCopilotUsageAvailable,
  ServerCopilotUsageUnavailable,
]);
export type ServerCopilotUsage = typeof ServerCopilotUsage.Type;

const ServerCopilotReasoningOption = Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS);

export const ServerCopilotReasoningProbeInput = Schema.Struct({
  model: TrimmedNonEmptyString,
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});
export type ServerCopilotReasoningProbeInput = typeof ServerCopilotReasoningProbeInput.Type;

const ServerCopilotReasoningProbeSupported = Schema.Struct({
  status: Schema.Literal("supported"),
  fetchedAt: IsoDateTime,
  model: TrimmedNonEmptyString,
  options: Schema.Array(ServerCopilotReasoningOption),
  currentValue: Schema.optional(ServerCopilotReasoningOption),
});

const ServerCopilotReasoningProbeUnavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  fetchedAt: IsoDateTime,
  model: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});

export const ServerCopilotReasoningProbe = Schema.Union([
  ServerCopilotReasoningProbeSupported,
  ServerCopilotReasoningProbeUnavailable,
]);
export type ServerCopilotReasoningProbe = typeof ServerCopilotReasoningProbe.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
});
export type ServerConfig = typeof ServerConfig.Type;

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
