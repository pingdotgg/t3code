import * as CodexAppServerClientFactoryService from "./CodexAppServerClientFactory.ts";
import * as ClaudeAgentSdkQueryRunnerService from "./ClaudeAgentSdkQueryRunner.ts";
import * as Layer from "effect/Layer";

import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAgentSdkQueryRunnerService.ClaudeAgentSdkQueryRunner
  | CodexAppServerClientFactoryService.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | CursorKeychain.CursorKeychain
  | IdAllocator.IdAllocatorV2;

/**
 * `providerContinuationRequestsLayer` must be the same layer reference the
 * orchestration runtime provides to its continuation worker so Effect layer
 * memoization yields one shared queue.
 */
export const layer = Layer.mergeAll(
  ClaudeAgentSdkQueryRunnerService.layer,
  CodexAppServerClientFactoryService.layer,
  CursorAgentSdk.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  CursorKeychain.layer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
);
