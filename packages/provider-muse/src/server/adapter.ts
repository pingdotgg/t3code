import {
  type NodeId,
  type OrchestrationV2ProviderCapabilities,
  type PlanId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunId,
  type RuntimeRequestId,
  type ServerProviderModel,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import type { MuseSettings } from "../settings.ts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type { createMuseSdkHost } from "./sdk.ts";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { MUSE_PROVIDER, MuseProviderCapabilitiesV2 } from "./museCapabilities.ts";
import { makeMuseOpenSession } from "./museSession.ts";

export interface MuseAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelCatalog?: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  readonly createHost?: typeof createMuseSdkHost;
  readonly requestTimeoutMs?: number;
  readonly nativeEventLogger?: ProviderEventLoggers.EventNdjsonLogger;
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

export const makeMuseAdapterV2 = Effect.fn("makeMuseAdapterV2")(function* (
  options: MuseAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const agentScope = yield* AgentScope;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: MUSE_PROVIDER,
    getCapabilities: Effect.fn("MuseAdapter.getCapabilities")(function () {
      return Effect.succeed(MuseProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("MuseAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: makeMuseOpenSession({
      options,
      idAllocator,
      providerHost,
      fileSystem,
      mcpSessions,
      agentScope,
    }),
  });
});
