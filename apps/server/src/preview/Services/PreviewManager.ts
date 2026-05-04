import {
  type PreviewEnsureRuntimeInput,
  type PreviewEnsureRuntimeResult,
  type PreviewIssueAccessTokenInput,
  type PreviewIssueAccessTokenResult,
  type PreviewInspectProjectInput,
  type PreviewPrepareBootstrapThreadInput,
  type PreviewPrepareBootstrapThreadResult,
  type PreviewPreparePreviewGenerationTurnInput,
  type PreviewPreparePreviewGenerationTurnResult,
  type PreviewPreparePreviewRepairTurnInput,
  type PreviewPreparePreviewRepairTurnResult,
  type PreviewProjectEvent,
  type PreviewProjectInspectionResult,
  type PreviewResolveTargetInput,
  type PreviewResolveTargetResult,
  type PreviewSearchComponentsInput,
  type PreviewSearchComponentsResult,
  type PreviewStopRuntimeInput,
  type PreviewSubscribeProjectInput,
  PreviewRpcError,
  type ProjectId,
} from "@forma/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface PreviewRuntimeTarget {
  readonly projectId: ProjectId;
  readonly baseUrl: string;
}

export interface PreviewManagerShape {
  readonly inspectProject: (
    input: PreviewInspectProjectInput,
  ) => Effect.Effect<PreviewProjectInspectionResult, PreviewRpcError>;
  readonly searchComponents: (
    input: PreviewSearchComponentsInput,
  ) => Effect.Effect<PreviewSearchComponentsResult, PreviewRpcError>;
  readonly resolveTarget: (
    input: PreviewResolveTargetInput,
  ) => Effect.Effect<PreviewResolveTargetResult, PreviewRpcError>;
  readonly prepareBootstrapThread: (
    input: PreviewPrepareBootstrapThreadInput,
  ) => Effect.Effect<PreviewPrepareBootstrapThreadResult, PreviewRpcError>;
  readonly preparePreviewGenerationTurn: (
    input: PreviewPreparePreviewGenerationTurnInput,
  ) => Effect.Effect<PreviewPreparePreviewGenerationTurnResult, PreviewRpcError>;
  readonly preparePreviewRepairTurn: (
    input: PreviewPreparePreviewRepairTurnInput,
  ) => Effect.Effect<PreviewPreparePreviewRepairTurnResult, PreviewRpcError>;
  readonly ensureRuntime: (
    input: PreviewEnsureRuntimeInput,
  ) => Effect.Effect<PreviewEnsureRuntimeResult, PreviewRpcError>;
  readonly issueAccessToken: (
    input: PreviewIssueAccessTokenInput,
  ) => Effect.Effect<PreviewIssueAccessTokenResult, PreviewRpcError>;
  readonly stopRuntime: (input: PreviewStopRuntimeInput) => Effect.Effect<void, PreviewRpcError>;
  readonly streamProject: (
    input: PreviewSubscribeProjectInput,
  ) => Stream.Stream<PreviewProjectEvent, PreviewRpcError>;
  readonly getRuntimeTarget: (
    projectId: ProjectId,
  ) => Effect.Effect<PreviewRuntimeTarget | null, never>;
  readonly authenticateAccessToken: (
    projectId: ProjectId,
    accessToken: string,
  ) => Effect.Effect<boolean, never>;
}

export class PreviewManager extends Context.Service<PreviewManager, PreviewManagerShape>()(
  "forma/preview/Services/PreviewManager",
) {}
