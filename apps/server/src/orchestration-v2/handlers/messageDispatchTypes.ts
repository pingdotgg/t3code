import type {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type {
  latestContextTransfer,
  pendingForkTransferForThread,
  pendingMergeBackTransfersForThread,
} from "../Orchestrator.ts";
import type { MakeMessageHandlersDeps } from "./messageHandlerDeps.ts";
import type { resolveRunHandoff } from "./messageRunHandoff.ts";
import type { resolveMessageDispatchIntent } from "../CommandPolicy.ts";
import type { OrchestratorDispatchError } from "../orchestrationErrors.ts";

export type MessageDispatchCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>;

export type MessageDispatchMode = ReturnType<typeof resolveMessageDispatchIntent>;

export type CompleteSourcePlan = (
  occurredAt: DateTime.Utc,
) =>
  | Effect.Effect<void, never, never>
  | Effect.Effect<OrchestrationV2DomainEvent, OrchestratorDispatchError>;

/**
 * Enclosing-generator locals the extracted dispatch phases read. Each phase
 * receives this object explicitly instead of closing over `makeMessageHandlers`.
 */
export interface MessageDispatchInput {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly modelSelection: NonNullable<MessageDispatchCommand["modelSelection"]>;
  readonly dispatchMode: MessageDispatchMode;
  readonly dispatchText: string;
  readonly delegatedCompletion: OrchestrationV2ConversationMessage["delegatedCompletion"];
  readonly continuedTaskId: OrchestrationV2Run["delegatedTaskId"];
  readonly completeSourcePlan: CompleteSourcePlan;
  readonly goalStopRunId: RunId | undefined;
  readonly shouldQueue: boolean;
  readonly queueBehindRun: OrchestrationV2Run | undefined;
  readonly worktreeMissingRun: OrchestrationV2Run | undefined;
  readonly activeRun: OrchestrationV2Run | undefined;
  readonly activeProviderThread: OrchestrationV2ProviderThread | undefined;
  readonly heldRunsToRelease: ReadonlyArray<OrchestrationV2Run>;
  readonly pendingMergeBackTransfers: ReturnType<typeof pendingMergeBackTransfersForThread>;
  readonly worktreeSetupUnresolved: boolean;
}

/** Run identity the dispatch pipeline derives before choosing a start path. */
export interface MessageRunIdentity {
  readonly runId: RunId;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
  readonly isProviderSwitch: boolean;
  readonly latestCompletedRun: OrchestrationV2Run | undefined;
  readonly latestHandoffRun: OrchestrationV2Run | undefined;
  readonly legacyImportItems: any;
  readonly pendingForkTransfer: ReturnType<typeof pendingForkTransferForThread>;
  readonly pendingMergeBackTransfer: ReturnType<typeof latestContextTransfer>;
  readonly supersededMergeBackTransfers: ReturnType<typeof pendingMergeBackTransfersForThread>;
  readonly providerSwitchPlan:
    | Effect.Success<ReturnType<MakeMessageHandlersDeps["providerSwitchService"]["plan"]>>
    | null;
  readonly canResumeAcrossInstances: boolean;
  readonly sessionsToDetach: ReadonlyArray<OrchestrationV2ProviderSession>;
}

import type { prepareProviderThread } from "./messageProviderThread.ts";

export type ProviderThreadResult = Effect.Success<ReturnType<typeof prepareProviderThread>>;

export type RunHandoffResult = Effect.Success<ReturnType<typeof resolveRunHandoff>>;
