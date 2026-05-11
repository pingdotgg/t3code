import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationQueuedTurn,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationTurnQueue,
  OrchestrationTurnQueuePauseReason,
  ProviderInteractionMode,
  RuntimeMode,
  SourceProposedPlanReference,
} from "@forma/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { findThreadById } from "./commandInvariants.ts";

type TurnQueueCommandType =
  | "thread.turn.start"
  | "thread.turn.queue.promote"
  | "thread.turn.queue.remove"
  | "thread.turn.queue.resume"
  | "thread.turn.queue.pause";

export interface ResolvedTurnSnapshot {
  readonly messageId: OrchestrationQueuedTurn["messageId"];
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentIds: ReadonlyArray<string>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly titleSeed: string | null;
  readonly sourceProposedPlan: SourceProposedPlanReference | null;
}

function invariantError(
  commandType: TurnQueueCommandType,
  detail: string,
): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function isTurnSessionBusy(thread: Pick<OrchestrationThread, "session">): boolean {
  return thread.session?.status === "starting" || thread.session?.status === "running";
}

export function canStartTurnImmediately(
  thread: Pick<OrchestrationThread, "session" | "turnQueue">,
): boolean {
  return (
    thread.turnQueue.items.length === 0 &&
    thread.turnQueue.status === "idle" &&
    !isTurnSessionBusy(thread)
  );
}

export function canPromoteQueuedTurn(
  thread: Pick<OrchestrationThread, "session" | "turnQueue">,
): boolean {
  return (
    thread.turnQueue.status === "queued" &&
    thread.turnQueue.items.length > 0 &&
    !isTurnSessionBusy(thread)
  );
}

export function canPromoteQueuedTurnAfterLifecycleBarrier(
  thread: Pick<OrchestrationThread, "session" | "turnQueue" | "latestTurn" | "messages">,
): boolean {
  if (!canPromoteQueuedTurn(thread)) {
    return false;
  }

  if (thread.latestTurn === null) {
    return thread.messages.every((message) => message.role !== "user");
  }

  return (
    thread.latestTurn.completedAt !== null &&
    (thread.latestTurn.state === "completed" ||
      thread.latestTurn.state === "error" ||
      thread.latestTurn.state === "interrupted")
  );
}

export function resolveQueuedTurnSnapshot(input: {
  readonly thread: Pick<OrchestrationThread, "modelSelection">;
  readonly command: {
    readonly message: {
      readonly messageId: OrchestrationQueuedTurn["messageId"];
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    };
    readonly modelSelection?: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly titleSeed?: string;
    readonly sourceProposedPlan?: SourceProposedPlanReference;
    readonly createdAt: string;
  };
}): OrchestrationQueuedTurn {
  return {
    messageId: input.command.message.messageId,
    text: input.command.message.text,
    attachmentIds: input.command.message.attachments.map((attachment) => attachment.id),
    modelSelection: input.command.modelSelection ?? input.thread.modelSelection,
    runtimeMode: input.command.runtimeMode,
    interactionMode: input.command.interactionMode,
    titleSeed: input.command.titleSeed ?? null,
    sourceProposedPlan: input.command.sourceProposedPlan ?? null,
    queuedAt: input.command.createdAt,
  };
}

export function resolveImmediateTurnSnapshot(input: {
  readonly thread: Pick<OrchestrationThread, "modelSelection">;
  readonly command: {
    readonly message: {
      readonly messageId: OrchestrationQueuedTurn["messageId"];
      readonly text: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    };
    readonly modelSelection?: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly titleSeed?: string;
    readonly sourceProposedPlan?: SourceProposedPlanReference;
  };
}): ResolvedTurnSnapshot {
  return {
    messageId: input.command.message.messageId,
    text: input.command.message.text,
    attachments: input.command.message.attachments,
    attachmentIds: input.command.message.attachments.map((attachment) => attachment.id),
    modelSelection: input.command.modelSelection ?? input.thread.modelSelection,
    runtimeMode: input.command.runtimeMode,
    interactionMode: input.command.interactionMode,
    titleSeed: input.command.titleSeed ?? null,
    sourceProposedPlan: input.command.sourceProposedPlan ?? null,
  };
}

export function resolvePromotedTurnSnapshot(input: {
  readonly queuedTurn: OrchestrationQueuedTurn;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): ResolvedTurnSnapshot {
  return {
    messageId: input.queuedTurn.messageId,
    text: input.queuedTurn.text,
    attachments: input.attachments,
    attachmentIds: input.queuedTurn.attachmentIds,
    modelSelection: input.queuedTurn.modelSelection,
    runtimeMode: input.queuedTurn.runtimeMode,
    interactionMode: input.queuedTurn.interactionMode,
    titleSeed: input.queuedTurn.titleSeed,
    sourceProposedPlan: input.queuedTurn.sourceProposedPlan,
  };
}

export function appendQueuedTurn(
  queue: OrchestrationTurnQueue,
  queuedTurn: OrchestrationQueuedTurn,
): OrchestrationTurnQueue {
  return {
    items: [...queue.items, queuedTurn],
    status: queue.status === "paused" ? "paused" : "queued",
    pauseReason: queue.status === "paused" ? queue.pauseReason : null,
  };
}

export function removeQueuedTurn(
  queue: OrchestrationTurnQueue,
  messageId: OrchestrationQueuedTurn["messageId"],
): OrchestrationTurnQueue {
  const items = queue.items.filter((item) => item.messageId !== messageId);
  if (items.length === 0) {
    return {
      items,
      status: "idle",
      pauseReason: null,
    };
  }
  return {
    items,
    status: queue.status,
    pauseReason: queue.status === "paused" ? queue.pauseReason : null,
  };
}

export function pauseQueuedTurns(
  queue: OrchestrationTurnQueue,
  reason: Exclude<OrchestrationTurnQueuePauseReason, null>,
): OrchestrationTurnQueue {
  if (queue.items.length === 0) {
    return {
      items: [],
      status: "idle",
      pauseReason: null,
    };
  }
  return {
    items: queue.items,
    status: "paused",
    pauseReason: reason,
  };
}

export function resumeQueuedTurns(queue: OrchestrationTurnQueue): OrchestrationTurnQueue {
  if (queue.items.length === 0) {
    return {
      items: [],
      status: "idle",
      pauseReason: null,
    };
  }
  return {
    items: queue.items,
    status: "queued",
    pauseReason: null,
  };
}

export function getHeadQueuedTurn(
  thread: Pick<OrchestrationThread, "turnQueue">,
): OrchestrationQueuedTurn | null {
  return thread.turnQueue.items[0] ?? null;
}

export function findQueuedTurnByMessageId(
  thread: Pick<OrchestrationThread, "turnQueue">,
  messageId: OrchestrationQueuedTurn["messageId"],
): OrchestrationQueuedTurn | null {
  return thread.turnQueue.items.find((item) => item.messageId === messageId) ?? null;
}

export const validateSourceProposedPlanReference = Effect.fn("validateSourceProposedPlanReference")(
  function* (input: {
    readonly readModel: OrchestrationReadModel;
    readonly commandType: TurnQueueCommandType;
    readonly targetThread: OrchestrationThread;
    readonly sourceProposedPlan: SourceProposedPlanReference | null | undefined;
  }) {
    if (!input.sourceProposedPlan) {
      return;
    }

    const sourceThread = findThreadById(input.readModel, input.sourceProposedPlan.threadId);
    const sourcePlan = sourceThread?.proposedPlans.find(
      (entry) => entry.id === input.sourceProposedPlan?.planId,
    );

    if (!sourceThread || !sourcePlan) {
      return yield* invariantError(
        input.commandType,
        `Proposed plan '${input.sourceProposedPlan.planId}' does not exist on thread '${input.sourceProposedPlan.threadId}'.`,
      );
    }

    if (sourceThread.projectId !== input.targetThread.projectId) {
      return yield* invariantError(
        input.commandType,
        `Proposed plan '${input.sourceProposedPlan.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
      );
    }

    if (sourcePlan.implementedAt !== null) {
      return yield* invariantError(
        input.commandType,
        `Proposed plan '${input.sourceProposedPlan.planId}' on thread '${sourceThread.id}' has already been implemented.`,
      );
    }
  },
);
