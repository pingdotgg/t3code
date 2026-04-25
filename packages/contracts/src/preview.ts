import { Effect, Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PreviewThreadId = TrimmedNonEmptyString;
const PreviewPath = TrimmedNonEmptyString;
const PreviewUrl = TrimmedNonEmptyString;
const PreviewCommandPart = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(8_192),
);
const PreviewComponentId = TrimmedNonEmptyString;
export type PreviewComponentId = typeof PreviewComponentId.Type;

export const PreviewComponentKind = Schema.Literals(["component", "legacy"]);
export type PreviewComponentKind = typeof PreviewComponentKind.Type;

export const PreviewPropKind = Schema.Literals([
  "boolean",
  "enum",
  "number",
  "text",
  "children",
  "callback",
  "unknown",
]);
export type PreviewPropKind = typeof PreviewPropKind.Type;

export const PreviewPropSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: PreviewPropKind,
  required: Schema.Boolean,
  options: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type PreviewPropSummary = typeof PreviewPropSummary.Type;

export const PreviewViewportPreset = Schema.Literals(["sm", "md", "lg", "xl"]);
export type PreviewViewportPreset = typeof PreviewViewportPreset.Type;

export const PreviewViewport = Schema.Struct({
  preset: Schema.optional(PreviewViewportPreset),
  width: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type PreviewViewport = typeof PreviewViewport.Type;

export const PreviewCaseManifest = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  viewport: Schema.optional(PreviewViewport),
});
export type PreviewCaseManifest = typeof PreviewCaseManifest.Type;

export const PreviewManifestEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  componentPath: PreviewPath,
  previewPath: PreviewPath,
  cases: Schema.Array(PreviewCaseManifest),
  defaultCaseId: TrimmedNonEmptyString,
});
export type PreviewManifestEntry = typeof PreviewManifestEntry.Type;

export const PreviewManifest = Schema.Struct({
  generatedAt: TrimmedNonEmptyString,
  appRoot: PreviewPath,
  entries: Schema.Array(PreviewManifestEntry),
});
export type PreviewManifest = typeof PreviewManifest.Type;

export const PreviewCatalogEntry = Schema.Struct({
  id: PreviewComponentId,
  label: TrimmedNonEmptyString,
  componentPath: PreviewPath,
  exportName: TrimmedNonEmptyString,
  kind: PreviewComponentKind,
  propSummary: Schema.Array(PreviewPropSummary),
  sourceHash: TrimmedNonEmptyString,
  usageHints: Schema.Array(TrimmedNonEmptyString),
  supported: Schema.Boolean,
  unsupportedReason: Schema.optional(TrimmedNonEmptyString),
  legacyPreviewPath: Schema.optional(PreviewPath),
});
export type PreviewCatalogEntry = typeof PreviewCatalogEntry.Type;

export const PreviewCatalogManifest = Schema.Struct({
  generatedAt: TrimmedNonEmptyString,
  appRoot: PreviewPath,
  entries: Schema.Array(PreviewCatalogEntry),
});
export type PreviewCatalogManifest = typeof PreviewCatalogManifest.Type;

export const PreviewScopeMode = Schema.Literal("thread-first");
export type PreviewScopeMode = typeof PreviewScopeMode.Type;

export const PreviewScopeDirection = Schema.Literals(["forward", "reverse", "both"]);
export type PreviewScopeDirection = typeof PreviewScopeDirection.Type;

export const PreviewScopeReason = Schema.Literals([
  "changed",
  "same-file",
  "import",
  "importer",
  "legacy",
]);
export type PreviewScopeReason = typeof PreviewScopeReason.Type;

export const PreviewScopedEntry = Schema.Struct({
  id: PreviewComponentId,
  label: TrimmedNonEmptyString,
  componentPath: PreviewPath,
  exportName: TrimmedNonEmptyString,
  kind: PreviewComponentKind,
  propSummary: Schema.Array(PreviewPropSummary),
  sourceHash: TrimmedNonEmptyString,
  usageHints: Schema.Array(TrimmedNonEmptyString),
  supported: Schema.Boolean,
  unsupportedReason: Schema.optional(TrimmedNonEmptyString),
  legacyPreviewPath: Schema.optional(PreviewPath),
  relationship: PreviewScopeReason,
  distance: NonNegativeInt,
});
export type PreviewScopedEntry = typeof PreviewScopedEntry.Type;

export const PreviewScopeManifest = Schema.Struct({
  generatedAt: TrimmedNonEmptyString,
  appRoot: PreviewPath,
  entries: Schema.Array(PreviewScopedEntry),
});
export type PreviewScopeManifest = typeof PreviewScopeManifest.Type;

export const PreviewGenerationStatus = Schema.Literals(["pending", "ready", "error"]);
export type PreviewGenerationStatus = typeof PreviewGenerationStatus.Type;

export const PreviewGenerationWarningSeverity = Schema.Literals(["info", "warn", "error"]);
export type PreviewGenerationWarningSeverity = typeof PreviewGenerationWarningSeverity.Type;

export const PreviewGenerationWarning = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  severity: PreviewGenerationWarningSeverity,
});
export type PreviewGenerationWarning = typeof PreviewGenerationWarning.Type;

export const PreviewGenerationConfidence = Schema.Literals(["high", "medium", "low"]);
export type PreviewGenerationConfidence = typeof PreviewGenerationConfidence.Type;

export const PreviewGeneratedCaseManifest = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  viewport: Schema.optional(PreviewViewport),
});
export type PreviewGeneratedCaseManifest = typeof PreviewGeneratedCaseManifest.Type;

export const PreviewControlKind = Schema.Literals(["boolean", "enum", "number", "text"]);
export type PreviewControlKind = typeof PreviewControlKind.Type;

export const PreviewControlOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
});
export type PreviewControlOption = typeof PreviewControlOption.Type;

export const PreviewControlValue = Schema.Union([
  Schema.Boolean,
  Schema.Int,
  TrimmedNonEmptyString,
]);
export type PreviewControlValue = typeof PreviewControlValue.Type;

export const PreviewControlValueMap = Schema.Record(Schema.String, PreviewControlValue);
export type PreviewControlValueMap = typeof PreviewControlValueMap.Type;

export const PreviewControlDefinition = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: PreviewControlKind,
  required: Schema.Boolean,
  options: Schema.optional(Schema.Array(PreviewControlOption)),
  min: Schema.optional(Schema.Int),
  max: Schema.optional(Schema.Int),
  defaultValue: Schema.optional(PreviewControlValue),
});
export type PreviewControlDefinition = typeof PreviewControlDefinition.Type;

const PreviewGeneratedRenderToken = TrimmedNonEmptyString;
export type PreviewGeneratedRenderToken = typeof PreviewGeneratedRenderToken.Type;

export const PreviewGenerationSnapshot = Schema.Struct({
  componentId: PreviewComponentId,
  label: TrimmedNonEmptyString,
  status: PreviewGenerationStatus,
  generatedAt: TrimmedNonEmptyString,
  sourceHash: TrimmedNonEmptyString,
  confidence: PreviewGenerationConfidence,
  renderToken: Schema.NullOr(PreviewGeneratedRenderToken),
  defaultCaseId: Schema.NullOr(TrimmedNonEmptyString),
  cases: Schema.Array(PreviewGeneratedCaseManifest),
  controls: Schema.Array(PreviewControlDefinition),
  warnings: Schema.Array(PreviewGenerationWarning),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type PreviewGenerationSnapshot = typeof PreviewGenerationSnapshot.Type;

export const PreviewSessionStatus = Schema.Literals([
  "unsupported",
  "starting",
  "ready",
  "stopping",
  "error",
]);
export type PreviewSessionStatus = typeof PreviewSessionStatus.Type;

export const PreviewSessionLogLevel = Schema.Literals(["info", "warn", "error"]);
export type PreviewSessionLogLevel = typeof PreviewSessionLogLevel.Type;

export const PreviewSessionLogEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  level: PreviewSessionLogLevel,
  message: TrimmedNonEmptyString,
  createdAt: TrimmedNonEmptyString,
});
export type PreviewSessionLogEntry = typeof PreviewSessionLogEntry.Type;

export const PreviewSessionErrorReason = Schema.Literals([
  "missing-config",
  "config-invalid",
  "command-invalid",
  "start-failed",
  "ready-timeout",
  "manifest-invalid",
  "unexpected",
]);
export type PreviewSessionErrorReason = typeof PreviewSessionErrorReason.Type;

export const PreviewSessionError = Schema.Struct({
  reason: PreviewSessionErrorReason,
  message: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  command: Schema.Array(PreviewCommandPart),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type PreviewSessionError = typeof PreviewSessionError.Type;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: PreviewThreadId,
  cwd: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workspaceRoot: TrimmedNonEmptyString,
  status: PreviewSessionStatus,
  baseUrl: Schema.NullOr(PreviewUrl),
  manifestUrl: Schema.NullOr(PreviewUrl),
  command: Schema.Array(PreviewCommandPart),
  launchCwd: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  startedAt: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: TrimmedNonEmptyString,
  error: Schema.NullOr(PreviewSessionError),
  logs: Schema.Array(PreviewSessionLogEntry),
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: PreviewThreadId,
  cwd: TrimmedNonEmptyString,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type PreviewOpenInput = typeof PreviewOpenInput.Type;

export const PreviewRestartInput = PreviewOpenInput;
export type PreviewRestartInput = typeof PreviewRestartInput.Type;

export const PreviewCloseInput = Schema.Struct({
  threadId: PreviewThreadId,
});
export type PreviewCloseInput = typeof PreviewCloseInput.Type;

export const PreviewSubscribeInput = Schema.Struct({
  threadId: PreviewThreadId,
});
export type PreviewSubscribeInput = typeof PreviewSubscribeInput.Type;

export const PreviewCatalogInput = Schema.Struct({
  threadId: PreviewThreadId,
});
export type PreviewCatalogInput = typeof PreviewCatalogInput.Type;

export const PreviewScopeInput = Schema.Struct({
  threadId: PreviewThreadId,
  changedFiles: Schema.Array(TrimmedNonEmptyString),
  mode: PreviewScopeMode,
  hopCount: NonNegativeInt,
  direction: PreviewScopeDirection,
  visualOnly: Schema.Boolean,
});
export type PreviewScopeInput = typeof PreviewScopeInput.Type;

export const PreviewGenerationInput = Schema.Struct({
  threadId: PreviewThreadId,
  componentId: PreviewComponentId,
});
export type PreviewGenerationInput = typeof PreviewGenerationInput.Type;

export const PreviewRegenerateInput = PreviewGenerationInput;
export type PreviewRegenerateInput = typeof PreviewRegenerateInput.Type;

export const PreviewRegisterGeneratedInput = Schema.Struct({
  componentId: PreviewComponentId,
  componentPath: PreviewPath,
  sourceHash: TrimmedNonEmptyString,
  moduleSource: TrimmedNonEmptyString,
});
export type PreviewRegisterGeneratedInput = typeof PreviewRegisterGeneratedInput.Type;

const PreviewSnapshotStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: PreviewSessionSnapshot,
});

export const PreviewSessionStreamEvent = Schema.Union([PreviewSnapshotStreamEvent]);
export type PreviewSessionStreamEvent = typeof PreviewSessionStreamEvent.Type;

const PreviewRenderReadyMessage = Schema.Struct({
  source: Schema.Literal("forma-preview"),
  type: Schema.Literal("ready"),
  loadToken: TrimmedNonEmptyString,
  previewId: TrimmedNonEmptyString,
  caseId: TrimmedNonEmptyString,
});

const PreviewRenderErrorMessage = Schema.Struct({
  source: Schema.Literal("forma-preview"),
  type: Schema.Literal("error"),
  loadToken: TrimmedNonEmptyString,
  previewId: TrimmedNonEmptyString,
  caseId: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});

export const PreviewRenderMessage = Schema.Union([
  PreviewRenderReadyMessage,
  PreviewRenderErrorMessage,
]);
export type PreviewRenderMessage = typeof PreviewRenderMessage.Type;

export const PreviewRenderControlMessage = Schema.Struct({
  source: Schema.Literal("forma-preview-parent"),
  type: Schema.Literal("update"),
  loadToken: TrimmedNonEmptyString,
  renderToken: Schema.optional(PreviewGeneratedRenderToken),
  caseId: TrimmedNonEmptyString,
  viewportWidth: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  controlValues: PreviewControlValueMap,
});
export type PreviewRenderControlMessage = typeof PreviewRenderControlMessage.Type;

export class PreviewManagerError extends Schema.TaggedErrorClass<PreviewManagerError>()(
  "PreviewManagerError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const PreviewManagerRpcError = Schema.Union([PreviewManagerError]);
export type PreviewManagerRpcError = typeof PreviewManagerRpcError.Type;

export const PreviewOpenInputWithDefaults = Schema.Struct({
  threadId: PreviewThreadId,
  cwd: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
