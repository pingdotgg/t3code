import * as Layer from "effect/Layer";

import {
  ClaudeAgentSdkQueryRunner,
  claudeAgentSdkQueryRunnerLiveLayer,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  CodexAppServerClientFactory,
  codexAppServerClientFactoryFromSettingsLayer,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CursorAgentSdkRunner,
  cursorAgentSdkRunnerLiveLayer,
} from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../../orchestration-v2/IdAllocator.ts";
import { layer as providerContinuationRequestsLayer } from "../../orchestration-v2/ProviderContinuationRequests.ts";
import { layer as providerInteractionModeReflectionsLayer } from "../../orchestration-v2/ProviderInteractionModeReflections.ts";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAgentSdkQueryRunner
  | CodexAppServerClientFactory
  | CursorAgentSdkRunner
  | IdAllocatorV2;

/**
 * Infrastructure shared by the V2 adapters materialized inside provider
 * instances. `providerContinuationRequestsLayer` and
 * `providerInteractionModeReflectionsLayer` must be the same layer references
 * the orchestration runtime provides to its worker halves so Effect layer
 * memoization yields one shared queue each; a missing entry here silently
 * resolves the Context.Reference default, which drops every offer.
 */
export const ProviderOrchestrationAdapterInfrastructureLive = Layer.mergeAll(
  claudeAgentSdkQueryRunnerLiveLayer,
  codexAppServerClientFactoryFromSettingsLayer,
  cursorAgentSdkRunnerLiveLayer,
  idAllocatorLayer,
  providerContinuationRequestsLayer,
  providerInteractionModeReflectionsLayer,
);
