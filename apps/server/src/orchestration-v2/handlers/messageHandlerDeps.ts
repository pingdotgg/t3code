import type { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import type { IdAllocatorV2Error } from "@t3tools/provider-core/server/IdAllocator";
import type { OrchestrationV2Command } from "@t3tools/contracts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import type { CommandId } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import type { EventIdAllocator } from "../orchestrationEmitters.ts";
import type { CheckpointServiceV2Shape } from "../CheckpointService.ts";
import type { CommandPolicyV2Shape } from "../CommandPolicy.ts";
import type { ContextHandoffServiceV2Shape } from "../ContextHandoffService.ts";
import type { EventSinkV2Shape } from "../EventSink.ts";
import type { ProviderAdapterRegistryV2Shape } from "../ProviderAdapterRegistry.ts";
import type { ProviderSessionManagerV2Shape } from "../ProviderSessionManager.ts";
import type { ProviderSwitchServiceV2Shape } from "../ProviderSwitchService.ts";
import type { RuntimePolicyV2Shape } from "../RuntimePolicy.ts";
import { isCheckpointRestoreIsolated } from "../CheckpointRestoreSafety.ts";
import type { ProjectionRecordField } from "../ProjectionStore.ts";
import type { ProjectionRecordFilter } from "../ProjectionStore.ts";
import type { ProjectionRecords } from "../ProjectionStore.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { OrchestratorCommandRejectedError } from "../orchestrationErrors.ts";
import { OrchestratorDispatchError } from "../orchestrationErrors.ts";
import { OrchestratorDomainEventStreamError } from "../orchestrationErrors.ts";
import { OrchestratorProjectionError } from "../orchestrationErrors.ts";
import { OrchestratorProviderAdapterError } from "../orchestrationErrors.ts";
import { OrchestratorSubagentThreadReadOnlyError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAboveModeLimitError } from "../orchestrationErrors.ts";
import { OrchestratorThreadAlreadyExistsError } from "../orchestrationErrors.ts";
import { RunId } from "@t3tools/contracts";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

type AnyOrchestratorError =
  | OrchestratorDispatchError
  | OrchestratorThreadAlreadyExistsError
  | OrchestratorCommandRejectedError
  | OrchestratorProjectionError
  | OrchestratorDomainEventStreamError
  | OrchestratorProviderAdapterError
  | OrchestratorSubagentThreadReadOnlyError
  | OrchestratorThreadAboveModeLimitError;

import { lastDeliveredRunForProviderThread, latestContextTransfer, nextRunOrdinal, pendingForkTransferForThread, pendingMergeBackTransfersForThread, rootProviderThreadsForProvider, worktreeSetupPending } from "../Orchestrator.ts";

export interface MakeMessageHandlersDeps {
  readonly eventSink: EventSinkV2Shape;
  readonly idAllocator: EventIdAllocator;
  readonly ensureGoalCommandSupported: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly disposeAllDelegatedCompletionCohorts: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly loadProjectionForCommand: <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorProjectionError>;
  readonly getProjectionWithPendingEvents: (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, AnyOrchestratorError, never>;
  readonly nextTurnItemOrdinal: (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) => Effect.Effect<number, OrchestratorProjectionError, never>;
  readonly goalDriverFor: (
    command: OrchestrationV2ServerCommand,
    providerInstanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderDriverKind | undefined, OrchestratorDispatchError, never>;
  readonly notificationTasks: (
    threadId: ThreadId,
    message: Pick<OrchestrationV2ConversationMessage, "delegatedCompletion">,
    loaded: ReadonlyArray<OrchestrationV2Subagent>,
  ) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly pendingThreadTitleGenerationEffect: (...args: any[]) => any;
  readonly emit: (
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    command: OrchestrationV2ServerCommand,
  ) => (
    event: Omit<OrchestrationV2DomainEvent, "id">,
  ) => Effect.Effect<OrchestrationV2DomainEvent, OrchestratorDispatchError>;
  readonly dispatchQueuedRunCancel: (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly checkpointService: CheckpointServiceV2Shape;
  readonly closePendingLinkRequests: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly commandPolicy: CommandPolicyV2Shape;
  readonly contextHandoffService: ContextHandoffServiceV2Shape;
  readonly dispatchRuntimeRequestRespond: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly dispatchSteerIntoRun: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly projects: Parameters<typeof isCheckpointRestoreIsolated>[2]["projects"];
  readonly providerAdapters: ProviderAdapterRegistryV2Shape;
  readonly providerSessionIdFor: (...args: any[]) => Effect.Effect<ProviderSessionId, AnyOrchestratorError | ProviderAdapterV2Error | IdAllocatorV2Error, never>;
  readonly providerSessions: ProviderSessionManagerV2Shape;
  readonly providerSwitchService: ProviderSwitchServiceV2Shape;
  readonly readHandoffItems: (
    threadId: ThreadId,
    runIds?: ReadonlyArray<RunId | null>,
  ) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly readInheritedItems: (thread: OrchestrationV2AppThread) => Effect.Effect<any, OrchestratorProjectionError, never>;
  readonly releaseGuestAttachments: (
    command: { readonly commandId: CommandId; readonly threadId: ThreadId },
    before: OrchestrationV2AppThread["guestShare"],
    after: OrchestrationV2AppThread["guestShare"],
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) => Effect.Effect<void, AnyOrchestratorError, never>;
  readonly runtimePolicy: RuntimePolicyV2Shape;
  readonly sessionHasBackgroundWork: (...args: any[]) => Effect.Effect<boolean, AnyOrchestratorError, never>;
  readonly stopReachedRun: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
  readonly stopRunForQueuedCommand: (...args: any[]) => Effect.Effect<any, AnyOrchestratorError, never>;
}
