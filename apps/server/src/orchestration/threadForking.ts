import { createHash } from "node:crypto";
import type {
  MessageId,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationProposedPlanId,
  OrchestrationThread,
  OrchestrationThreadActivity,
  SourceProposedPlanReference,
  ThreadId,
  TurnId,
  EventId,
} from "@forma/contracts";

export type ForkCloneEntityKind = "message" | "turn" | "plan" | "activity";

function buildForkCloneHash(input: {
  readonly targetThreadId: ThreadId;
  readonly entityKind: ForkCloneEntityKind;
  readonly sourceId: string;
}): string {
  return createHash("sha256")
    .update(`${input.targetThreadId}:${input.entityKind}:${input.sourceId}`)
    .digest("hex");
}

export function buildForkedThreadTitle(
  sourceTitle: OrchestrationThread["title"],
): OrchestrationThread["title"] {
  return `${sourceTitle} (fork)` as OrchestrationThread["title"];
}

export function forkThreadHasStarted(
  thread: Pick<
    OrchestrationThread,
    "latestTurn" | "messages" | "proposedPlans" | "activities" | "session"
  >,
): boolean {
  return (
    thread.latestTurn !== null ||
    thread.messages.length > 0 ||
    thread.proposedPlans.length > 0 ||
    thread.activities.length > 0 ||
    thread.session !== null
  );
}

export function forkSourceThreadHasRunningTurn(
  thread: Pick<OrchestrationThread, "session">,
): boolean {
  return thread.session?.status === "starting" || thread.session?.status === "running";
}

export function forkedMessageId(targetThreadId: ThreadId, sourceId: MessageId): MessageId {
  return `fork-message-${buildForkCloneHash({
    targetThreadId,
    entityKind: "message",
    sourceId,
  })}` as MessageId;
}

export function forkedTurnId(targetThreadId: ThreadId, sourceId: TurnId): TurnId {
  return `fork-turn-${buildForkCloneHash({
    targetThreadId,
    entityKind: "turn",
    sourceId,
  })}` as TurnId;
}

export function forkedPlanId(
  targetThreadId: ThreadId,
  sourceId: OrchestrationProposedPlanId,
): OrchestrationProposedPlanId {
  return `fork-plan-${buildForkCloneHash({
    targetThreadId,
    entityKind: "plan",
    sourceId,
  })}` as OrchestrationProposedPlanId;
}

export function forkedActivityId(targetThreadId: ThreadId, sourceId: EventId): EventId {
  return `fork-activity-${buildForkCloneHash({
    targetThreadId,
    entityKind: "activity",
    sourceId,
  })}` as EventId;
}

function remapForkSourceProposedPlanReference(input: {
  readonly targetThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly sourceProposedPlan: SourceProposedPlanReference;
}): SourceProposedPlanReference {
  if (input.sourceProposedPlan.threadId !== input.sourceThreadId) {
    return input.sourceProposedPlan;
  }
  return {
    threadId: input.targetThreadId,
    planId: forkedPlanId(input.targetThreadId, input.sourceProposedPlan.planId),
  };
}

function cloneForkedLatestTurn(input: {
  readonly targetThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly latestTurn: OrchestrationLatestTurn;
}): OrchestrationLatestTurn {
  return {
    turnId: forkedTurnId(input.targetThreadId, input.latestTurn.turnId),
    state: input.latestTurn.state,
    requestedAt: input.latestTurn.requestedAt,
    startedAt: input.latestTurn.startedAt,
    completedAt: input.latestTurn.completedAt,
    assistantMessageId:
      input.latestTurn.assistantMessageId === null
        ? null
        : forkedMessageId(input.targetThreadId, input.latestTurn.assistantMessageId),
    ...(input.latestTurn.sourceProposedPlan
      ? {
          sourceProposedPlan: remapForkSourceProposedPlanReference({
            targetThreadId: input.targetThreadId,
            sourceThreadId: input.sourceThreadId,
            sourceProposedPlan: input.latestTurn.sourceProposedPlan,
          }),
        }
      : {}),
  };
}

function cloneForkedMessage(input: {
  readonly targetThreadId: ThreadId;
  readonly message: OrchestrationMessage;
}): OrchestrationMessage {
  return {
    id: forkedMessageId(input.targetThreadId, input.message.id),
    role: input.message.role,
    text: input.message.text,
    ...(input.message.attachments ? { attachments: input.message.attachments } : {}),
    turnId:
      input.message.turnId === null
        ? null
        : forkedTurnId(input.targetThreadId, input.message.turnId),
    streaming: input.message.streaming,
    createdAt: input.message.createdAt,
    updatedAt: input.message.updatedAt,
  };
}

function cloneForkedProposedPlan(input: {
  readonly targetThreadId: ThreadId;
  readonly proposedPlan: OrchestrationProposedPlan;
}): OrchestrationProposedPlan {
  return {
    id: forkedPlanId(input.targetThreadId, input.proposedPlan.id),
    turnId:
      input.proposedPlan.turnId === null
        ? null
        : forkedTurnId(input.targetThreadId, input.proposedPlan.turnId),
    planMarkdown: input.proposedPlan.planMarkdown,
    implementedAt: input.proposedPlan.implementedAt,
    implementationThreadId: input.proposedPlan.implementationThreadId,
    createdAt: input.proposedPlan.createdAt,
    updatedAt: input.proposedPlan.updatedAt,
  };
}

function cloneForkedActivity(input: {
  readonly targetThreadId: ThreadId;
  readonly activity: OrchestrationThreadActivity;
}): OrchestrationThreadActivity {
  return {
    id: forkedActivityId(input.targetThreadId, input.activity.id),
    tone: input.activity.tone,
    kind: input.activity.kind,
    summary: input.activity.summary,
    payload: input.activity.payload,
    turnId:
      input.activity.turnId === null
        ? null
        : forkedTurnId(input.targetThreadId, input.activity.turnId),
    ...(input.activity.sequence !== undefined ? { sequence: input.activity.sequence } : {}),
    createdAt: input.activity.createdAt,
  };
}

export function cloneThreadForFork(input: {
  readonly sourceThread: OrchestrationThread;
  readonly targetThreadId: ThreadId;
  readonly createdAt: string;
}): OrchestrationThread {
  return {
    id: input.targetThreadId,
    projectId: input.sourceThread.projectId,
    title: buildForkedThreadTitle(input.sourceThread.title),
    modelSelection: input.sourceThread.modelSelection,
    runtimeMode: input.sourceThread.runtimeMode,
    interactionMode: input.sourceThread.interactionMode,
    branch: input.sourceThread.branch,
    worktreePath: input.sourceThread.worktreePath,
    latestTurn:
      input.sourceThread.latestTurn === null
        ? null
        : cloneForkedLatestTurn({
            targetThreadId: input.targetThreadId,
            sourceThreadId: input.sourceThread.id,
            latestTurn: input.sourceThread.latestTurn,
          }),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    deletedAt: null,
    messages: input.sourceThread.messages.map((message) =>
      cloneForkedMessage({
        targetThreadId: input.targetThreadId,
        message,
      }),
    ),
    proposedPlans: input.sourceThread.proposedPlans.map((proposedPlan) =>
      cloneForkedProposedPlan({
        targetThreadId: input.targetThreadId,
        proposedPlan,
      }),
    ),
    activities: input.sourceThread.activities.map((activity) =>
      cloneForkedActivity({
        targetThreadId: input.targetThreadId,
        activity,
      }),
    ),
    checkpoints: [],
    turnQueue: {
      items: [],
      status: "idle",
      pauseReason: null,
    },
    session: null,
  };
}

export function remapForkSourceProposedPlan(input: {
  readonly targetThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly sourceProposedPlanThreadId: ThreadId | null;
  readonly sourceProposedPlanId: OrchestrationProposedPlanId | null;
}): {
  readonly sourceProposedPlanThreadId: ThreadId | null;
  readonly sourceProposedPlanId: OrchestrationProposedPlanId | null;
} {
  if (
    input.sourceProposedPlanThreadId === null ||
    input.sourceProposedPlanId === null ||
    input.sourceProposedPlanThreadId !== input.sourceThreadId
  ) {
    return {
      sourceProposedPlanThreadId: input.sourceProposedPlanThreadId,
      sourceProposedPlanId: input.sourceProposedPlanId,
    };
  }
  return {
    sourceProposedPlanThreadId: input.targetThreadId,
    sourceProposedPlanId: forkedPlanId(input.targetThreadId, input.sourceProposedPlanId),
  };
}
