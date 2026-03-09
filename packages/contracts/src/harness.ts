import { Schema } from "effect";
import {
  EventId,
  HarnessConnectorId,
  HarnessProfileId,
  HarnessSessionId,
  IsoDateTime,
  NonNegativeInt,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

export const HarnessKind = Schema.Literals(["codex-app-server", "claude-agent-sdk", "opencode"]);
export type HarnessKind = typeof HarnessKind.Type;

export const HarnessAdapterFamily = Schema.Literals(["process", "sdk", "bridge"]);
export type HarnessAdapterFamily = typeof HarnessAdapterFamily.Type;

export const HarnessConnectionMode = Schema.Literals(["spawned", "attached"]);
export type HarnessConnectionMode = typeof HarnessConnectionMode.Type;

export const HarnessSessionState = Schema.Literals([
  "idle",
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type HarnessSessionState = typeof HarnessSessionState.Type;

export const HarnessTurnState = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type HarnessTurnState = typeof HarnessTurnState.Type;

export const HarnessModelSwitchMode = Schema.Literals([
  "unsupported",
  "restart-required",
  "in-session",
]);
export type HarnessModelSwitchMode = typeof HarnessModelSwitchMode.Type;

export const HarnessPermissionKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "tool",
  "exec",
  "other",
]);
export type HarnessPermissionKind = typeof HarnessPermissionKind.Type;

export const HarnessPermissionDecision = Schema.Literals([
  "accept",
  "accept-for-session",
  "decline",
  "cancel",
]);
export type HarnessPermissionDecision = typeof HarnessPermissionDecision.Type;

export const HarnessElicitationAnswer = Schema.Array(TrimmedNonEmptyString);
export type HarnessElicitationAnswer = typeof HarnessElicitationAnswer.Type;

export const HarnessQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type HarnessQuestionOption = typeof HarnessQuestionOption.Type;

export const HarnessQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(HarnessQuestionOption),
  multiple: Schema.optional(Schema.Boolean),
  custom: Schema.optional(Schema.Boolean),
});
export type HarnessQuestion = typeof HarnessQuestion.Type;

export const HarnessCapabilitySet = Schema.Struct({
  resume: Schema.Boolean,
  cancel: Schema.Boolean,
  modelSwitch: HarnessModelSwitchMode,
  permissions: Schema.Boolean,
  elicitation: Schema.Boolean,
  toolLifecycle: Schema.Boolean,
  reasoningStream: Schema.Boolean,
  planStream: Schema.Boolean,
  fileArtifacts: Schema.Boolean,
  checkpoints: Schema.Boolean,
  subagents: Schema.Boolean,
});
export type HarnessCapabilitySet = typeof HarnessCapabilitySet.Type;

export const CodexHarnessProfileConfig = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  env: Schema.optional(UnknownRecord),
});
export type CodexHarnessProfileConfig = typeof CodexHarnessProfileConfig.Type;

export const ClaudeHarnessProfileConfig = Schema.Struct({
  modulePath: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  env: Schema.optional(UnknownRecord),
  sessionMode: Schema.optional(TrimmedNonEmptyString),
});
export type ClaudeHarnessProfileConfig = typeof ClaudeHarnessProfileConfig.Type;

export const OpenCodeHarnessProfileConfig = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  baseUrl: Schema.optional(TrimmedNonEmptyString),
  directory: Schema.optional(TrimmedNonEmptyString),
  username: Schema.optional(TrimmedNonEmptyString),
  password: Schema.optional(TrimmedNonEmptyString),
  env: Schema.optional(UnknownRecord),
});
export type OpenCodeHarnessProfileConfig = typeof OpenCodeHarnessProfileConfig.Type;

export const HarnessProfileConfig = Schema.Struct({
  codexAppServer: Schema.optional(CodexHarnessProfileConfig),
  claudeAgentSdk: Schema.optional(ClaudeHarnessProfileConfig),
  opencode: Schema.optional(OpenCodeHarnessProfileConfig),
});
export type HarnessProfileConfig = typeof HarnessProfileConfig.Type;

export const HarnessProfile = Schema.Struct({
  id: HarnessProfileId,
  name: TrimmedNonEmptyString,
  harness: HarnessKind,
  adapterFamily: HarnessAdapterFamily,
  connectionMode: HarnessConnectionMode,
  enabled: Schema.Boolean,
  config: HarnessProfileConfig,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HarnessProfile = typeof HarnessProfile.Type;

export const HarnessBinding = Schema.Struct({
  sessionId: HarnessSessionId,
  profileId: Schema.NullOr(HarnessProfileId),
  harness: HarnessKind,
  adapterKey: TrimmedNonEmptyString,
  connectionMode: HarnessConnectionMode,
  nativeSessionId: Schema.optional(TrimmedNonEmptyString),
  nativeThreadId: Schema.optional(ThreadId),
  nativeTurnId: Schema.optional(TurnId),
  resumeCursor: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(UnknownRecord),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HarnessBinding = typeof HarnessBinding.Type;

export const HarnessSession = Schema.Struct({
  id: HarnessSessionId,
  profileId: Schema.NullOr(HarnessProfileId),
  harness: HarnessKind,
  adapterKey: TrimmedNonEmptyString,
  connectionMode: HarnessConnectionMode,
  title: Schema.NullOr(TrimmedNonEmptyString),
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  model: Schema.NullOr(TrimmedNonEmptyString),
  mode: Schema.NullOr(TrimmedNonEmptyString),
  state: HarnessSessionState,
  activeTurnId: Schema.NullOr(TurnId),
  nativeSessionId: Schema.NullOr(TrimmedNonEmptyString),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  capabilities: HarnessCapabilitySet,
  metadata: Schema.optional(UnknownRecord),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HarnessSession = typeof HarnessSession.Type;

export const HarnessPendingPermission = Schema.Struct({
  id: RuntimeRequestId,
  sessionId: HarnessSessionId,
  turnId: Schema.NullOr(TurnId),
  kind: HarnessPermissionKind,
  title: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Unknown),
  createdAt: IsoDateTime,
});
export type HarnessPendingPermission = typeof HarnessPendingPermission.Type;

export const HarnessPendingElicitation = Schema.Struct({
  id: RuntimeRequestId,
  sessionId: HarnessSessionId,
  turnId: Schema.NullOr(TurnId),
  questions: Schema.Array(HarnessQuestion),
  createdAt: IsoDateTime,
});
export type HarnessPendingElicitation = typeof HarnessPendingElicitation.Type;

export const HarnessConnectorHealth = Schema.Literals(["connected", "degraded", "disconnected"]);
export type HarnessConnectorHealth = typeof HarnessConnectorHealth.Type;

export const HarnessConnector = Schema.Struct({
  id: HarnessConnectorId,
  profileId: Schema.NullOr(HarnessProfileId),
  harness: HarnessKind,
  adapterKey: TrimmedNonEmptyString,
  health: HarnessConnectorHealth,
  description: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  lastSeenAt: IsoDateTime,
  metadata: Schema.optional(UnknownRecord),
});
export type HarnessConnector = typeof HarnessConnector.Type;

export const HarnessSnapshot = Schema.Struct({
  sequence: NonNegativeInt,
  updatedAt: IsoDateTime,
  profiles: Schema.Array(HarnessProfile),
  sessions: Schema.Array(HarnessSession),
  bindings: Schema.Array(HarnessBinding),
  pendingPermissions: Schema.Array(HarnessPendingPermission),
  pendingElicitations: Schema.Array(HarnessPendingElicitation),
  connectors: Schema.Array(HarnessConnector),
});
export type HarnessSnapshot = typeof HarnessSnapshot.Type;

export const HarnessNativeFrame = Schema.Struct({
  id: EventId,
  sessionId: HarnessSessionId,
  harness: HarnessKind,
  adapterKey: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  source: TrimmedNonEmptyString,
  payload: Schema.Unknown,
});
export type HarnessNativeFrame = typeof HarnessNativeFrame.Type;
