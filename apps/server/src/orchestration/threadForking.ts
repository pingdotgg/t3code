import { createHash } from "node:crypto";
import type {
  EventId,
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
} from "@t3tools/contracts";

type ForkCloneEntityKind = "message" | "turn" | "plan" | "activity";

function forkCloneHash(input: {
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
  return `fork-message-${forkCloneHash({
    targetThreadId,
    entityKind: "message",
    sourceId,
  })}` as MessageId;
}

export function forkedTurnId(targetThreadId: ThreadId, sourceId: TurnId): TurnId {
  return `fork-turn-${forkCloneHash({
    targetThreadId,
    entityKind: "turn",
    sourceId,
  })}` as TurnId;
}

export function forkedPlanId(
  targetThreadId: ThreadId,
  sourceId: OrchestrationProposedPlanId,
): OrchestrationProposedPlanId {
  return `fork-plan-${forkCloneHash({
    targetThreadId,
    entityKind: "plan",
    sourceId,
  })}` as OrchestrationProposedPlanId;
}

export function forkedActivityId(targetThreadId: ThreadId, sourceId: EventId): EventId {
  return `fork-activity-${forkCloneHash({
    targetThreadId,
    entityKind: "activity",
    sourceId,
  })}` as EventId;
}

function remapSourcePlan(input: {
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

function cloneLatestTurn(input: {
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
          sourceProposedPlan: remapSourcePlan({
            targetThreadId: input.targetThreadId,
            sourceThreadId: input.sourceThreadId,
            sourceProposedPlan: input.latestTurn.sourceProposedPlan,
          }),
        }
      : {}),
  };
}

function cloneMessage(targetThreadId: ThreadId, message: OrchestrationMessage) {
  return {
    ...message,
    id: forkedMessageId(targetThreadId, message.id),
    turnId: message.turnId === null ? null : forkedTurnId(targetThreadId, message.turnId),
  };
}

function clonePlan(targetThreadId: ThreadId, plan: OrchestrationProposedPlan) {
  return {
    ...plan,
    id: forkedPlanId(targetThreadId, plan.id),
    turnId: plan.turnId === null ? null : forkedTurnId(targetThreadId, plan.turnId),
  };
}

function cloneActivity(targetThreadId: ThreadId, activity: OrchestrationThreadActivity) {
  return {
    ...activity,
    id: forkedActivityId(targetThreadId, activity.id),
    turnId: activity.turnId === null ? null : forkedTurnId(targetThreadId, activity.turnId),
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
        : cloneLatestTurn({
            targetThreadId: input.targetThreadId,
            sourceThreadId: input.sourceThread.id,
            latestTurn: input.sourceThread.latestTurn,
          }),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: input.sourceThread.messages.map((message) =>
      cloneMessage(input.targetThreadId, message),
    ),
    proposedPlans: input.sourceThread.proposedPlans.map((plan) =>
      clonePlan(input.targetThreadId, plan),
    ),
    activities: input.sourceThread.activities.map((activity) =>
      cloneActivity(input.targetThreadId, activity),
    ),
    checkpoints: [],
    session: null,
  };
}

export function remapForkSourceProposedPlan(input: {
  readonly targetThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly sourceProposedPlanThreadId: ThreadId | null;
  readonly sourceProposedPlanId: OrchestrationProposedPlanId | null;
}) {
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
