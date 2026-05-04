import { Effect, Schema } from "effect";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectRelativePath } from "./project.ts";

const PREVIEW_WORKSPACE_ROOT_RELATIVE_PATH_MAX_LENGTH = 512;

export const PreviewProvider = Schema.Literal("componentHarness");
export type PreviewProvider = typeof PreviewProvider.Type;

export const PreviewFramework = Schema.Literals([
  "react-next",
  "react-remix",
  "react-router",
  "react-vite",
  "unsupported",
]);
export type PreviewFramework = typeof PreviewFramework.Type;

export const PreviewWorkspaceRootRelativePath = Schema.String.check(
  Schema.isMaxLength(PREVIEW_WORKSPACE_ROOT_RELATIVE_PATH_MAX_LENGTH),
);
export type PreviewWorkspaceRootRelativePath = typeof PreviewWorkspaceRootRelativePath.Type;

export const ProjectPreviewWorkspaceStatus = Schema.Literals([
  "bootstrapping",
  "generation_in_progress",
  "repair_in_progress",
  "ready",
  "failed",
]);
export type ProjectPreviewWorkspaceStatus = typeof ProjectPreviewWorkspaceStatus.Type;

export const ProjectPreviewWorkspaceRecord = Schema.Struct({
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  status: ProjectPreviewWorkspaceStatus,
  lastPreviewFileRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastError: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
});
export type ProjectPreviewWorkspaceRecord = typeof ProjectPreviewWorkspaceRecord.Type;

export const PreviewInspectProjectInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
});
export type PreviewInspectProjectInput = typeof PreviewInspectProjectInput.Type;

export const PreviewProjectStatus = Schema.Literals(["ready", "needsBootstrap", "unsupported"]);
export type PreviewProjectStatus = typeof PreviewProjectStatus.Type;

export const PreviewProjectInspectionResult = Schema.Struct({
  projectId: ProjectId,
  provider: PreviewProvider,
  framework: PreviewFramework,
  status: PreviewProjectStatus,
  bootstrapFilesPresent: Schema.Boolean,
  summary: TrimmedNonEmptyString,
});
export type PreviewProjectInspectionResult = typeof PreviewProjectInspectionResult.Type;

export const PreviewSearchComponentsInput = Schema.Struct({
  projectId: ProjectId,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
});
export type PreviewSearchComponentsInput = typeof PreviewSearchComponentsInput.Type;

export const PreviewComponentEntry = Schema.Struct({
  relativePath: ProjectRelativePath,
  displayName: TrimmedNonEmptyString,
});
export type PreviewComponentEntry = typeof PreviewComponentEntry.Type;

export const PreviewSearchComponentsResult = Schema.Struct({
  components: Schema.Array(PreviewComponentEntry),
  truncated: Schema.Boolean,
});
export type PreviewSearchComponentsResult = typeof PreviewSearchComponentsResult.Type;

export const PreviewResolveTargetInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ProjectRelativePath,
});
export type PreviewResolveTargetInput = typeof PreviewResolveTargetInput.Type;

export const PreviewScenarioEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type PreviewScenarioEntry = typeof PreviewScenarioEntry.Type;

const PreviewResolvedTarget = Schema.Struct({
  status: Schema.Literal("resolved"),
  relativePath: ProjectRelativePath,
  previewFileRelativePath: ProjectRelativePath,
  iframePath: TrimmedNonEmptyString,
  directIframeUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  initialScenarioId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  scenarioChoices: Schema.Array(PreviewScenarioEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

const PreviewNeedsBootstrap = Schema.Struct({
  status: Schema.Literal("needsBootstrap"),
  relativePath: ProjectRelativePath,
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  existingThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  reason: TrimmedNonEmptyString,
});

const PreviewNeedsGeneration = Schema.Struct({
  status: Schema.Literal("needsGeneration"),
  relativePath: ProjectRelativePath,
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  previewFileRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reason: TrimmedNonEmptyString,
});

const PreviewRuntimeError = Schema.Struct({
  status: Schema.Literal("runtimeError"),
  relativePath: ProjectRelativePath,
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  previewFileRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  message: TrimmedNonEmptyString,
});

const PreviewTargetNotFound = Schema.Struct({
  status: Schema.Literal("notFound"),
  relativePath: ProjectRelativePath,
});

const PreviewUnsupportedTarget = Schema.Struct({
  status: Schema.Literal("unsupportedTarget"),
  relativePath: ProjectRelativePath,
  reason: TrimmedNonEmptyString,
});

export const PreviewResolveTargetResult = Schema.Union([
  PreviewResolvedTarget,
  PreviewNeedsBootstrap,
  PreviewNeedsGeneration,
  PreviewRuntimeError,
  PreviewTargetNotFound,
  PreviewUnsupportedTarget,
]);
export type PreviewResolveTargetResult = typeof PreviewResolveTargetResult.Type;

export const PreviewPrepareBootstrapThreadInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ProjectRelativePath,
});
export type PreviewPrepareBootstrapThreadInput = typeof PreviewPrepareBootstrapThreadInput.Type;

export const PreviewPrepareBootstrapThreadResult = Schema.Struct({
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  existingThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadTitle: TrimmedNonEmptyString,
  initialPrompt: TrimmedNonEmptyString,
  inspectionSummary: TrimmedNonEmptyString,
  reviewSummary: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type PreviewPrepareBootstrapThreadResult = typeof PreviewPrepareBootstrapThreadResult.Type;

export const PreviewPreparePreviewGenerationTurnInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ProjectRelativePath,
});
export type PreviewPreparePreviewGenerationTurnInput =
  typeof PreviewPreparePreviewGenerationTurnInput.Type;

export const PreviewPreparePreviewGenerationTurnResult = Schema.Struct({
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  turnPrompt: TrimmedNonEmptyString,
  previewFileRelativePath: ProjectRelativePath,
});
export type PreviewPreparePreviewGenerationTurnResult =
  typeof PreviewPreparePreviewGenerationTurnResult.Type;

export const PreviewPreparePreviewRepairTurnInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ProjectRelativePath,
  errorMessage: TrimmedNonEmptyString,
  previewFileRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type PreviewPreparePreviewRepairTurnInput = typeof PreviewPreparePreviewRepairTurnInput.Type;

export const PreviewPreparePreviewRepairTurnResult = Schema.Struct({
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  turnPrompt: TrimmedNonEmptyString,
  previewFileRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type PreviewPreparePreviewRepairTurnResult =
  typeof PreviewPreparePreviewRepairTurnResult.Type;

export const PreviewEnsureRuntimeInput = Schema.Struct({
  projectId: ProjectId,
});
export type PreviewEnsureRuntimeInput = typeof PreviewEnsureRuntimeInput.Type;

export const PreviewIssueAccessTokenInput = Schema.Struct({
  projectId: ProjectId,
});
export type PreviewIssueAccessTokenInput = typeof PreviewIssueAccessTokenInput.Type;

export const PreviewStopRuntimeInput = Schema.Struct({
  projectId: ProjectId,
});
export type PreviewStopRuntimeInput = typeof PreviewStopRuntimeInput.Type;

export const PreviewSubscribeProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type PreviewSubscribeProjectInput = typeof PreviewSubscribeProjectInput.Type;

export const PreviewEnsureRuntimeResult = Schema.Struct({
  projectId: ProjectId,
  provider: PreviewProvider,
  started: Schema.Boolean,
  iframeBasePath: TrimmedNonEmptyString,
});
export type PreviewEnsureRuntimeResult = typeof PreviewEnsureRuntimeResult.Type;

export const PreviewIssueAccessTokenResult = Schema.Struct({
  projectId: ProjectId,
  accessToken: TrimmedNonEmptyString,
});
export type PreviewIssueAccessTokenResult = typeof PreviewIssueAccessTokenResult.Type;

export const PreviewProjectEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("runtime.starting"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("runtime.ready"),
    projectId: ProjectId,
    iframeBasePath: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("runtime.error"),
    projectId: ProjectId,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("runtime.stopped"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("setup.progress"),
    projectId: ProjectId,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("setup.complete"),
    projectId: ProjectId,
    changedFiles: Schema.Array(ProjectRelativePath),
  }),
  Schema.Struct({
    kind: Schema.Literal("setup.error"),
    projectId: ProjectId,
    message: TrimmedNonEmptyString,
  }),
]);
export type PreviewProjectEvent = typeof PreviewProjectEvent.Type;

export class PreviewRpcError extends Schema.TaggedErrorClass<PreviewRpcError>()("PreviewRpcError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
