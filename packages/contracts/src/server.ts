import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";

export const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});
export type KeybindingsMalformedConfigIssue = typeof KeybindingsMalformedConfigIssue.Type;

export const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});
export type KeybindingsInvalidEntryIssue = typeof KeybindingsInvalidEntryIssue.Type;

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

export const ServerConfigIssues = Schema.Array(ServerConfigIssue);
export type ServerConfigIssues = typeof ServerConfigIssues.Type;

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

export const ServerProviderStatuses = Schema.Array(ServerProviderStatus);
export type ServerProviderStatuses = typeof ServerProviderStatuses.Type;

export const ServerRuntimePlatform = Schema.Literals(["windows", "linux", "macos"]);
export type ServerRuntimePlatform = typeof ServerRuntimePlatform.Type;

export const ServerPathStyle = Schema.Literals(["windows", "posix"]);
export type ServerPathStyle = typeof ServerPathStyle.Type;

export const ServerWindowsInteropMode = Schema.Literals(["windows-native", "wsl-hosted"]);
export type ServerWindowsInteropMode = typeof ServerWindowsInteropMode.Type;

export const ServerRuntimeEnvironment = Schema.Struct({
  platform: ServerRuntimePlatform,
  pathStyle: ServerPathStyle,
  isWsl: Schema.Boolean,
  windowsInteropMode: Schema.NullOr(ServerWindowsInteropMode),
  wslDistroName: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerRuntimeEnvironment = typeof ServerRuntimeEnvironment.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
  runtimeEnvironment: ServerRuntimeEnvironment,
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
