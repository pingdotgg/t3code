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

export const PreviewProvider = Schema.Literal("storybook");
export type PreviewProvider = typeof PreviewProvider.Type;

export const PreviewTargetKind = Schema.Literals(["component", "story"]);
export type PreviewTargetKind = typeof PreviewTargetKind.Type;

export const PreviewPackageManager = Schema.Literals(["bun", "pnpm", "yarn", "npm"]);
export type PreviewPackageManager = typeof PreviewPackageManager.Type;

export const PreviewControlsBridgeStatus = Schema.Literals([
  "installed",
  "missing",
  "manualRequired",
]);
export type PreviewControlsBridgeStatus = typeof PreviewControlsBridgeStatus.Type;

export const PreviewWorkspaceRootRelativePath = Schema.String.check(
  Schema.isMaxLength(PREVIEW_WORKSPACE_ROOT_RELATIVE_PATH_MAX_LENGTH),
);
export type PreviewWorkspaceRootRelativePath = typeof PreviewWorkspaceRootRelativePath.Type;

export const ProjectPreviewWorkspaceStatus = Schema.Literals([
  "unconfigured",
  "setup_in_progress",
  "setup_failed",
  "ready",
  "story_work_pending",
]);
export type ProjectPreviewWorkspaceStatus = typeof ProjectPreviewWorkspaceStatus.Type;

export const ProjectPreviewWorkspaceRecord = Schema.Struct({
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  status: ProjectPreviewWorkspaceStatus,
  lastTargetRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastError: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
});
export type ProjectPreviewWorkspaceRecord = typeof ProjectPreviewWorkspaceRecord.Type;

export const ProjectPreviewConfig = Schema.Struct({
  provider: PreviewProvider.pipe(Schema.withDecodingDefault(Effect.succeed("storybook"))),
  workspaceCommandOverrides: Schema.Record(
    PreviewWorkspaceRootRelativePath,
    TrimmedNonEmptyString,
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  startCommandOverride: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  componentStoryMappings: Schema.Record(ProjectRelativePath, ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ProjectPreviewConfig = typeof ProjectPreviewConfig.Type;

export const PreviewInspectProjectInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
});
export type PreviewInspectProjectInput = typeof PreviewInspectProjectInput.Type;

export const PreviewProjectStatus = Schema.Literals([
  "configured",
  "needsCommandOverride",
  "enableable",
  "unsupported",
]);
export type PreviewProjectStatus = typeof PreviewProjectStatus.Type;

export const PreviewProjectInspectionResult = Schema.Struct({
  projectId: ProjectId,
  provider: PreviewProvider,
  status: PreviewProjectStatus,
  framework: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  detectedStartCommands: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  storybookConfigPaths: Schema.Array(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  packageManager: Schema.NullOr(PreviewPackageManager).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  controlsBridgeStatus: PreviewControlsBridgeStatus.pipe(
    Schema.withDecodingDefault(Effect.succeed("missing")),
  ),
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
  targetKind: PreviewTargetKind,
});
export type PreviewResolveTargetInput = typeof PreviewResolveTargetInput.Type;

export const PreviewVariantEntry = Schema.Struct({
  storyId: TrimmedNonEmptyString,
  exportName: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type PreviewVariantEntry = typeof PreviewVariantEntry.Type;

export const PreviewStoryChoiceEntry = Schema.Struct({
  relativePath: ProjectRelativePath,
  displayName: TrimmedNonEmptyString,
});
export type PreviewStoryChoiceEntry = typeof PreviewStoryChoiceEntry.Type;

export const PreviewStoryWorkAction = Schema.Literals(["create", "fix"]);
export type PreviewStoryWorkAction = typeof PreviewStoryWorkAction.Type;

const PreviewResolvedTarget = Schema.Struct({
  status: Schema.Literal("resolved"),
  targetKind: PreviewTargetKind,
  relativePath: ProjectRelativePath,
  componentRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  storyRelativePath: ProjectRelativePath,
  initialStoryId: TrimmedNonEmptyString,
  iframePath: TrimmedNonEmptyString,
  directIframeUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  variants: Schema.Array(PreviewVariantEntry),
});

const PreviewNeedsStoryChoice = Schema.Struct({
  status: Schema.Literal("needsStoryChoice"),
  componentRelativePath: ProjectRelativePath,
  storyChoices: Schema.Array(PreviewStoryChoiceEntry),
});

const PreviewNeedsWorkspaceSetup = Schema.Struct({
  status: Schema.Literal("needsWorkspaceSetup"),
  targetKind: PreviewTargetKind,
  relativePath: ProjectRelativePath,
  ownerWorkspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  coveringWorkspaceRootRelativePath: Schema.NullOr(PreviewWorkspaceRootRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  existingThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  reason: TrimmedNonEmptyString,
});

const PreviewNeedsStoryWork = Schema.Struct({
  status: Schema.Literal("needsStoryWork"),
  componentRelativePath: ProjectRelativePath,
  storyRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  action: PreviewStoryWorkAction,
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});

const PreviewNeedsCommandOverride = Schema.Struct({
  status: Schema.Literal("needsCommandOverride"),
  targetKind: PreviewTargetKind,
  relativePath: ProjectRelativePath,
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  detectedCommands: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

const PreviewTargetNotFound = Schema.Struct({
  status: Schema.Literal("notFound"),
  targetKind: PreviewTargetKind,
  relativePath: ProjectRelativePath,
});

const PreviewUnsupportedTarget = Schema.Struct({
  status: Schema.Literal("unsupportedTarget"),
  targetKind: PreviewTargetKind,
  relativePath: ProjectRelativePath,
  reason: TrimmedNonEmptyString,
});

export const PreviewResolveTargetResult = Schema.Union([
  PreviewResolvedTarget,
  PreviewNeedsStoryChoice,
  PreviewNeedsWorkspaceSetup,
  PreviewNeedsStoryWork,
  PreviewNeedsCommandOverride,
  PreviewTargetNotFound,
  PreviewUnsupportedTarget,
]);
export type PreviewResolveTargetResult = typeof PreviewResolveTargetResult.Type;

export const PreviewChooseStoryMappingInput = Schema.Struct({
  projectId: ProjectId,
  componentRelativePath: ProjectRelativePath,
  storyRelativePath: ProjectRelativePath,
});
export type PreviewChooseStoryMappingInput = typeof PreviewChooseStoryMappingInput.Type;

export const PreviewSetStartCommandOverrideInput = Schema.Struct({
  projectId: ProjectId,
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  command: TrimmedNonEmptyString,
});
export type PreviewSetStartCommandOverrideInput = typeof PreviewSetStartCommandOverrideInput.Type;

export const PreviewPrepareWorkspaceSetupThreadInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ProjectRelativePath,
  targetKind: PreviewTargetKind,
});
export type PreviewPrepareWorkspaceSetupThreadInput =
  typeof PreviewPrepareWorkspaceSetupThreadInput.Type;

export const PreviewPrepareWorkspaceSetupThreadResult = Schema.Struct({
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  existingThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadTitle: TrimmedNonEmptyString,
  initialPrompt: TrimmedNonEmptyString,
  inspectionSummary: TrimmedNonEmptyString,
  reviewSummary: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type PreviewPrepareWorkspaceSetupThreadResult =
  typeof PreviewPrepareWorkspaceSetupThreadResult.Type;

export const PreviewPrepareStoryWorkTurnInput = Schema.Struct({
  projectId: ProjectId,
  componentRelativePath: ProjectRelativePath,
  action: PreviewStoryWorkAction,
});
export type PreviewPrepareStoryWorkTurnInput = typeof PreviewPrepareStoryWorkTurnInput.Type;

export const PreviewPrepareStoryWorkTurnResult = Schema.Struct({
  workspaceRootRelativePath: PreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  turnPrompt: TrimmedNonEmptyString,
  storyRelativePath: Schema.NullOr(ProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type PreviewPrepareStoryWorkTurnResult = typeof PreviewPrepareStoryWorkTurnResult.Type;

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
