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

export const SharedSkillsConfigInput = Schema.Struct({
  codexHomePath: Schema.optional(Schema.String),
  sharedSkillsPath: Schema.optional(Schema.String),
});
export type SharedSkillsConfigInput = typeof SharedSkillsConfigInput.Type;

export const SharedSkillStatus = Schema.Literals([
  "managed",
  "needs-migration",
  "needs-link",
  "conflict",
  "broken-link",
]);
export type SharedSkillStatus = typeof SharedSkillStatus.Type;

export const SharedSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  shortDescription: Schema.optional(Schema.String),
  iconPath: Schema.optional(Schema.String),
  brandColor: Schema.optional(Schema.String),
  markdownPath: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  status: SharedSkillStatus,
  codexPath: TrimmedNonEmptyString,
  sharedPath: TrimmedNonEmptyString,
  codexPathExists: Schema.Boolean,
  sharedPathExists: Schema.Boolean,
  symlinkedToSharedPath: Schema.Boolean,
});
export type SharedSkill = typeof SharedSkill.Type;

export const SharedSkillsState = Schema.Struct({
  codexHomePath: TrimmedNonEmptyString,
  codexSkillsPath: TrimmedNonEmptyString,
  agentsSkillsPath: TrimmedNonEmptyString,
  sharedSkillsPath: TrimmedNonEmptyString,
  initializationMarkerPath: TrimmedNonEmptyString,
  isInitialized: Schema.Boolean,
  skills: Schema.Array(SharedSkill),
  warnings: Schema.Array(TrimmedNonEmptyString),
});
export type SharedSkillsState = typeof SharedSkillsState.Type;

export const SharedSkillDetailInput = Schema.Struct({
  codexHomePath: Schema.optional(Schema.String),
  sharedSkillsPath: Schema.optional(Schema.String),
  skillName: TrimmedNonEmptyString,
});
export type SharedSkillDetailInput = typeof SharedSkillDetailInput.Type;

export const SharedSkillDetail = Schema.Struct({
  skill: SharedSkill,
  markdown: Schema.String,
});
export type SharedSkillDetail = typeof SharedSkillDetail.Type;

export const SharedSkillSetEnabledInput = Schema.Struct({
  codexHomePath: Schema.optional(Schema.String),
  sharedSkillsPath: Schema.optional(Schema.String),
  skillName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type SharedSkillSetEnabledInput = typeof SharedSkillSetEnabledInput.Type;

export const SharedSkillUninstallInput = Schema.Struct({
  codexHomePath: Schema.optional(Schema.String),
  sharedSkillsPath: Schema.optional(Schema.String),
  skillName: TrimmedNonEmptyString,
});
export type SharedSkillUninstallInput = typeof SharedSkillUninstallInput.Type;

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
