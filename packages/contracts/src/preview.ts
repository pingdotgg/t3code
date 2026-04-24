import { Effect, Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PreviewThreadId = TrimmedNonEmptyString;
const PreviewPath = TrimmedNonEmptyString;
const PreviewUrl = TrimmedNonEmptyString;
const PreviewCommandPart = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(8_192),
);

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
  caseId: TrimmedNonEmptyString,
  viewportWidth: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
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
