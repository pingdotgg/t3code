import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ClaudePluginUi from "../ClaudePluginUi.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CursorAgentSdk from "../../orchestration-v2/Adapters/CursorAgentSdk.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderContinuationRequests from "../../orchestration-v2/ProviderContinuationRequests.ts";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | IdAllocator.IdAllocatorV2;

/**
 * Infrastructure shared by the V2 adapters materialized inside provider
 * instances. `providerContinuationRequestsLayer` must be the same layer
 * reference the orchestration runtime provides to its continuation worker so
 * Effect layer memoization yields one shared queue.
 */
export const ProviderOrchestrationAdapterInfrastructureLive = Layer.mergeAll(
  // Same `ClaudePluginUi.layer` reference the server provides, so memoization
  // hands the runner and the websocket routes one shared instance.
  ClaudeAdapterV2.claudeAgentSdkQueryRunnerLiveLayer.pipe(Layer.provide(ClaudePluginUi.layer)),
  CodexAdapterV2.codexAppServerClientFactoryFromSettingsLayer,
  CursorAgentSdk.cursorAgentSdkRunnerLiveLayer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
);
