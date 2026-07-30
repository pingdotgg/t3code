/**
 * ComponentPreview - Schemas for the component preview harness.
 *
 * The component preview system builds and serves live React component
 * previews out of the user's own project via an isolated Vite dev server
 * ("harness"). It is unrelated to the browser preview surface in
 * `preview.ts` (desktop webview tabs).
 *
 * @module ComponentPreview
 */
import { Effect, Schema } from "effect";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const COMPONENT_PREVIEW_WORKSPACE_ROOT_RELATIVE_PATH_MAX_LENGTH = 512;
const COMPONENT_PREVIEW_PROJECT_RELATIVE_PATH_MAX_LENGTH = 512;

/** Project-relative path to a source file inside the previewed project. */
export const ComponentPreviewProjectRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMPONENT_PREVIEW_PROJECT_RELATIVE_PATH_MAX_LENGTH),
);
export type ComponentPreviewProjectRelativePath = typeof ComponentPreviewProjectRelativePath.Type;

export const ComponentPreviewProvider = Schema.Literal("componentHarness");
export type ComponentPreviewProvider = typeof ComponentPreviewProvider.Type;

export const ComponentPreviewFramework = Schema.Literals([
  "react-next",
  "react-remix",
  "react-router",
  "react-vite",
  "unsupported",
]);
export type ComponentPreviewFramework = typeof ComponentPreviewFramework.Type;

export const ComponentPreviewWorkspaceRootRelativePath = Schema.String.check(
  Schema.isMaxLength(COMPONENT_PREVIEW_WORKSPACE_ROOT_RELATIVE_PATH_MAX_LENGTH),
);
export type ComponentPreviewWorkspaceRootRelativePath =
  typeof ComponentPreviewWorkspaceRootRelativePath.Type;

export const ProjectComponentPreviewWorkspaceStatus = Schema.Literals([
  "bootstrapping",
  "generation_in_progress",
  "repair_in_progress",
  "ready",
  "failed",
]);
export type ProjectComponentPreviewWorkspaceStatus =
  typeof ProjectComponentPreviewWorkspaceStatus.Type;

export const ProjectComponentPreviewWorkspaceRecord = Schema.Struct({
  workspaceRootRelativePath: ComponentPreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  status: ProjectComponentPreviewWorkspaceStatus,
  lastPreviewFileRelativePath: Schema.NullOr(ComponentPreviewProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastError: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
});
export type ProjectComponentPreviewWorkspaceRecord =
  typeof ProjectComponentPreviewWorkspaceRecord.Type;

export const ComponentPreviewInspectProjectInput = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
});
export type ComponentPreviewInspectProjectInput = typeof ComponentPreviewInspectProjectInput.Type;

export const ComponentPreviewProjectStatus = Schema.Literals([
  "ready",
  "needsBootstrap",
  "unsupported",
]);
export type ComponentPreviewProjectStatus = typeof ComponentPreviewProjectStatus.Type;

export const ComponentPreviewProjectInspectionResult = Schema.Struct({
  projectId: ProjectId,
  provider: ComponentPreviewProvider,
  framework: ComponentPreviewFramework,
  status: ComponentPreviewProjectStatus,
  bootstrapFilesPresent: Schema.Boolean,
  summary: TrimmedNonEmptyString,
});
export type ComponentPreviewProjectInspectionResult =
  typeof ComponentPreviewProjectInspectionResult.Type;

export const ComponentPreviewSearchComponentsInput = Schema.Struct({
  projectId: ProjectId,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
});
export type ComponentPreviewSearchComponentsInput =
  typeof ComponentPreviewSearchComponentsInput.Type;

export const ComponentPreviewComponentEntry = Schema.Struct({
  relativePath: ComponentPreviewProjectRelativePath,
  displayName: TrimmedNonEmptyString,
});
export type ComponentPreviewComponentEntry = typeof ComponentPreviewComponentEntry.Type;

export const ComponentPreviewSearchComponentsResult = Schema.Struct({
  components: Schema.Array(ComponentPreviewComponentEntry),
  truncated: Schema.Boolean,
});
export type ComponentPreviewSearchComponentsResult =
  typeof ComponentPreviewSearchComponentsResult.Type;

export const ComponentPreviewResolveTargetInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ComponentPreviewProjectRelativePath,
});
export type ComponentPreviewResolveTargetInput = typeof ComponentPreviewResolveTargetInput.Type;

export const ComponentPreviewScenarioEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type ComponentPreviewScenarioEntry = typeof ComponentPreviewScenarioEntry.Type;

const ComponentPreviewResolvedTarget = Schema.Struct({
  status: Schema.Literal("resolved"),
  relativePath: ComponentPreviewProjectRelativePath,
  previewFileRelativePath: ComponentPreviewProjectRelativePath,
  iframePath: TrimmedNonEmptyString,
  directIframeUrl: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  initialScenarioId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  scenarioChoices: Schema.Array(ComponentPreviewScenarioEntry).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});

const ComponentPreviewNeedsBootstrap = Schema.Struct({
  status: Schema.Literal("needsBootstrap"),
  relativePath: ComponentPreviewProjectRelativePath,
  workspaceRootRelativePath: ComponentPreviewWorkspaceRootRelativePath,
  existingThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  reason: TrimmedNonEmptyString,
});

const ComponentPreviewNeedsGeneration = Schema.Struct({
  status: Schema.Literal("needsGeneration"),
  relativePath: ComponentPreviewProjectRelativePath,
  workspaceRootRelativePath: ComponentPreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  previewFileRelativePath: Schema.NullOr(ComponentPreviewProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reason: TrimmedNonEmptyString,
});

const ComponentPreviewRuntimeError = Schema.Struct({
  status: Schema.Literal("runtimeError"),
  relativePath: ComponentPreviewProjectRelativePath,
  workspaceRootRelativePath: ComponentPreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  previewFileRelativePath: Schema.NullOr(ComponentPreviewProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  message: TrimmedNonEmptyString,
});

const ComponentPreviewTargetNotFound = Schema.Struct({
  status: Schema.Literal("notFound"),
  relativePath: ComponentPreviewProjectRelativePath,
});

const ComponentPreviewUnsupportedTarget = Schema.Struct({
  status: Schema.Literal("unsupportedTarget"),
  relativePath: ComponentPreviewProjectRelativePath,
  reason: TrimmedNonEmptyString,
});

export const ComponentPreviewResolveTargetResult = Schema.Union([
  ComponentPreviewResolvedTarget,
  ComponentPreviewNeedsBootstrap,
  ComponentPreviewNeedsGeneration,
  ComponentPreviewRuntimeError,
  ComponentPreviewTargetNotFound,
  ComponentPreviewUnsupportedTarget,
]);
export type ComponentPreviewResolveTargetResult = typeof ComponentPreviewResolveTargetResult.Type;

export const ComponentPreviewPrepareBootstrapThreadInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ComponentPreviewProjectRelativePath,
});
export type ComponentPreviewPrepareBootstrapThreadInput =
  typeof ComponentPreviewPrepareBootstrapThreadInput.Type;

export const ComponentPreviewPrepareBootstrapThreadResult = Schema.Struct({
  workspaceRootRelativePath: ComponentPreviewWorkspaceRootRelativePath,
  existingThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  threadTitle: TrimmedNonEmptyString,
  initialPrompt: TrimmedNonEmptyString,
  inspectionSummary: TrimmedNonEmptyString,
  reviewSummary: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ComponentPreviewPrepareBootstrapThreadResult =
  typeof ComponentPreviewPrepareBootstrapThreadResult.Type;

export const ComponentPreviewPrepareGenerationTurnInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ComponentPreviewProjectRelativePath,
});
export type ComponentPreviewPrepareGenerationTurnInput =
  typeof ComponentPreviewPrepareGenerationTurnInput.Type;

export const ComponentPreviewPrepareGenerationTurnResult = Schema.Struct({
  workspaceRootRelativePath: ComponentPreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  turnPrompt: TrimmedNonEmptyString,
  previewFileRelativePath: ComponentPreviewProjectRelativePath,
});
export type ComponentPreviewPrepareGenerationTurnResult =
  typeof ComponentPreviewPrepareGenerationTurnResult.Type;

export const ComponentPreviewPrepareRepairTurnInput = Schema.Struct({
  projectId: ProjectId,
  relativePath: ComponentPreviewProjectRelativePath,
  errorMessage: TrimmedNonEmptyString,
  previewFileRelativePath: Schema.NullOr(ComponentPreviewProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ComponentPreviewPrepareRepairTurnInput =
  typeof ComponentPreviewPrepareRepairTurnInput.Type;

export const ComponentPreviewPrepareRepairTurnResult = Schema.Struct({
  workspaceRootRelativePath: ComponentPreviewWorkspaceRootRelativePath,
  threadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  turnPrompt: TrimmedNonEmptyString,
  previewFileRelativePath: Schema.NullOr(ComponentPreviewProjectRelativePath).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ComponentPreviewPrepareRepairTurnResult =
  typeof ComponentPreviewPrepareRepairTurnResult.Type;

export const ComponentPreviewEnsureRuntimeInput = Schema.Struct({
  projectId: ProjectId,
});
export type ComponentPreviewEnsureRuntimeInput = typeof ComponentPreviewEnsureRuntimeInput.Type;

export const ComponentPreviewIssueAccessTokenInput = Schema.Struct({
  projectId: ProjectId,
});
export type ComponentPreviewIssueAccessTokenInput =
  typeof ComponentPreviewIssueAccessTokenInput.Type;

export const ComponentPreviewStopRuntimeInput = Schema.Struct({
  projectId: ProjectId,
});
export type ComponentPreviewStopRuntimeInput = typeof ComponentPreviewStopRuntimeInput.Type;

export const ComponentPreviewSubscribeProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ComponentPreviewSubscribeProjectInput =
  typeof ComponentPreviewSubscribeProjectInput.Type;

export const ComponentPreviewEnsureRuntimeResult = Schema.Struct({
  projectId: ProjectId,
  provider: ComponentPreviewProvider,
  started: Schema.Boolean,
  iframeBasePath: TrimmedNonEmptyString,
});
export type ComponentPreviewEnsureRuntimeResult = typeof ComponentPreviewEnsureRuntimeResult.Type;

export const ComponentPreviewIssueAccessTokenResult = Schema.Struct({
  projectId: ProjectId,
  accessToken: TrimmedNonEmptyString,
});
export type ComponentPreviewIssueAccessTokenResult =
  typeof ComponentPreviewIssueAccessTokenResult.Type;

export const ComponentPreviewProjectEvent = Schema.Union([
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
    changedFiles: Schema.Array(ComponentPreviewProjectRelativePath),
  }),
  Schema.Struct({
    kind: Schema.Literal("setup.error"),
    projectId: ProjectId,
    message: TrimmedNonEmptyString,
  }),
]);
export type ComponentPreviewProjectEvent = typeof ComponentPreviewProjectEvent.Type;

export class ComponentPreviewRpcError extends Schema.TaggedErrorClass<ComponentPreviewRpcError>()(
  "ComponentPreviewRpcError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
