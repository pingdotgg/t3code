/**
 * ComponentPreviewManager - Service interface for the component preview harness.
 *
 * Builds and serves live React component previews out of the user's own
 * project via an isolated Vite dev server. Unrelated to the desktop webview
 * browser preview in `../../preview/Manager.ts`.
 *
 * @module ComponentPreviewManager
 */
import {
  type ComponentPreviewEnsureRuntimeInput,
  type ComponentPreviewEnsureRuntimeResult,
  type ComponentPreviewInspectProjectInput,
  type ComponentPreviewIssueAccessTokenInput,
  type ComponentPreviewIssueAccessTokenResult,
  type ComponentPreviewPrepareBootstrapThreadInput,
  type ComponentPreviewPrepareBootstrapThreadResult,
  type ComponentPreviewPrepareGenerationTurnInput,
  type ComponentPreviewPrepareGenerationTurnResult,
  type ComponentPreviewPrepareRepairTurnInput,
  type ComponentPreviewPrepareRepairTurnResult,
  type ComponentPreviewProjectEvent,
  type ComponentPreviewProjectInspectionResult,
  type ComponentPreviewResolveTargetInput,
  type ComponentPreviewResolveTargetResult,
  type ComponentPreviewSearchComponentsInput,
  type ComponentPreviewSearchComponentsResult,
  type ComponentPreviewStopRuntimeInput,
  type ComponentPreviewSubscribeProjectInput,
  ComponentPreviewRpcError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ComponentPreviewRuntimeTarget {
  readonly projectId: ProjectId;
  readonly baseUrl: string;
}

export interface ComponentPreviewManagerShape {
  readonly inspectProject: (
    input: ComponentPreviewInspectProjectInput,
  ) => Effect.Effect<ComponentPreviewProjectInspectionResult, ComponentPreviewRpcError>;
  readonly searchComponents: (
    input: ComponentPreviewSearchComponentsInput,
  ) => Effect.Effect<ComponentPreviewSearchComponentsResult, ComponentPreviewRpcError>;
  readonly resolveTarget: (
    input: ComponentPreviewResolveTargetInput,
  ) => Effect.Effect<ComponentPreviewResolveTargetResult, ComponentPreviewRpcError>;
  readonly prepareBootstrapThread: (
    input: ComponentPreviewPrepareBootstrapThreadInput,
  ) => Effect.Effect<ComponentPreviewPrepareBootstrapThreadResult, ComponentPreviewRpcError>;
  readonly prepareGenerationTurn: (
    input: ComponentPreviewPrepareGenerationTurnInput,
  ) => Effect.Effect<ComponentPreviewPrepareGenerationTurnResult, ComponentPreviewRpcError>;
  readonly prepareRepairTurn: (
    input: ComponentPreviewPrepareRepairTurnInput,
  ) => Effect.Effect<ComponentPreviewPrepareRepairTurnResult, ComponentPreviewRpcError>;
  readonly ensureRuntime: (
    input: ComponentPreviewEnsureRuntimeInput,
  ) => Effect.Effect<ComponentPreviewEnsureRuntimeResult, ComponentPreviewRpcError>;
  readonly issueAccessToken: (
    input: ComponentPreviewIssueAccessTokenInput,
  ) => Effect.Effect<ComponentPreviewIssueAccessTokenResult, ComponentPreviewRpcError>;
  readonly stopRuntime: (
    input: ComponentPreviewStopRuntimeInput,
  ) => Effect.Effect<void, ComponentPreviewRpcError>;
  readonly streamProject: (
    input: ComponentPreviewSubscribeProjectInput,
  ) => Stream.Stream<ComponentPreviewProjectEvent, ComponentPreviewRpcError>;
  readonly getRuntimeTarget: (
    projectId: ProjectId,
  ) => Effect.Effect<ComponentPreviewRuntimeTarget | null, never>;
  readonly authenticateAccessToken: (
    projectId: ProjectId,
    accessToken: string,
  ) => Effect.Effect<boolean, never>;
}

export class ComponentPreviewManager extends Context.Service<
  ComponentPreviewManager,
  ComponentPreviewManagerShape
>()("t3/componentPreview/Services/ComponentPreviewManager") {}
