import { createHash } from "node:crypto";
import { ChildWaitDeadlineAt, EventId } from "@t3tools/contracts";
import type {
  ChildWaitCondition,
  ChildNudgeUpdate,
  ChildThreadLifecycle,
  CommandId,
  MessageId,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationQueuedTurn,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadDelegation,
  ThreadId,
  ThreadNudging,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";

import { automaticArchiveIsApproved, type AutomaticArchiveGuard } from "./automaticArchiveGuard.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  findThreadById,
  requireWritableProjectForThread,
  requireThread,
  requireThreadAbsent,
  requireThreadNotArchived,
  nextQueuePosition,
  requireQueuedTurn,
  requireThreadReadyForTurnStart,
  requireThreadWithInFlightTurn,
  threadHasPendingInteraction,
  threadHasQueuedTurnStart,
  threadBlocksSettlement,
  threadHasSettlementOverride,
  threadIsSnoozed,
  CHILD_DECISION_BLOCKED_DETAIL,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { collectActiveThreadSubtree } from "./threadHierarchy.ts";
import { assistantTurnCount } from "./Utils.ts";
import { findCanonicalActiveWorktreeOwner } from "./worktreeOwnership.ts";
import {
  childNudgePrompt,
  childPendingRequestUpdate,
  childWakeReason,
  isAutomaticChildNudgeBlocked,
  queueChildNudge,
  queueChildNudgeBatch,
} from "./childNudging.ts";
import {
  childWaitIsSatisfied,
  childWaitIsSatisfiedByUpdates,
  evaluateChildFollowUp,
} from "@t3tools/shared/childFollowUp";
import {
  sameThreadPullRequest,
  sameThreadPullRequestAssociation,
} from "@t3tools/shared/threadPullRequests";
import {
  bindDelegationExecution,
  childReportIdentity,
  classifyChildReport,
  classifyExecutionProvenance,
  legacyUpdateId,
  mintDispatchRecord,
  transitionDelegationExecution,
  type RecordedReportOutcome,
} from "./dispatchAuthority.ts";
import {
  delegationStallEpisode,
  indexDelegationChildren,
  settleDelegation,
} from "./delegationSettlement.ts";
import {
  acceptValidationResult,
  claimValidationLease,
  isValidationRunTerminal,
  planValidationRun,
  transitionValidationGate,
  transitionValidationRunStatus,
  validationTargetEquals,
  validationRunEffectiveStatus,
} from "@t3tools/client-runtime/validation-lifecycle";

const FORK_TITLE_PREFIX = "Forked: ";
const INITIAL_ASSIGNMENT_REQUIRED_DETAIL =
  "This child is waiting for its original assignment. Retry the original delegated request or create a separate thread for unrelated work.";

function isInitialDelegationDispatch(delegation: ThreadDelegation | undefined): boolean {
  return (
    delegation !== undefined &&
    delegation.completedAt === null &&
    delegation.dispatchId !== undefined &&
    delegation.dispatchTurnId == null &&
    (delegation.dispatchReason === undefined || delegation.dispatchReason === "assigned")
  );
}

const isChildWaitDeadlineAt = Schema.is(ChildWaitDeadlineAt);
/**
 * Blocked-on-you work must never stay hidden inside a settled row, so these
 * activity kinds reset the settlement lifecycle. Hoisted because
 * `thread.activity.append` is the hottest command in the system.
 */
const SETTLEMENT_WAKING_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "user-input.requested",
  "provider.turn.start.failed",
]);
const nowIso = () => new Date().toISOString();
type PlannedOrchestrationEvent = {
  [T in OrchestrationEvent["type"]]: Omit<Extract<OrchestrationEvent, { type: T }>, "sequence">;
}[OrchestrationEvent["type"]];
type ChildLifecycleNotificationEvent = Extract<
  PlannedOrchestrationEvent,
  { type: "thread.child-lifecycle-notified" }
>;
type CrossThreadSendRecordedEvent = Extract<
  PlannedOrchestrationEvent,
  { type: "thread.cross-thread-send-recorded" }
>;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

type CollaborationRequest = NonNullable<OrchestrationThread["collaborationRequests"]>[number];

function plannedCommandId(event: PlannedOrchestrationEvent): CommandId {
  if (event.commandId === null) {
    throw new Error(`Planned event '${event.type}' is missing its command id.`);
  }
  return event.commandId;
}

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload" | "commandId"> & {
  readonly commandId: CommandId;
} {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function collaborationRequestLocation(readModel: OrchestrationReadModel, requestId: string) {
  for (const thread of readModel.threads) {
    const request = thread.collaborationRequests?.find((entry) => entry.requestId === requestId);
    if (request) return { thread, request };
  }
  return null;
}

function executionAuthorityMatches(
  expected: {
    readonly executionId: string;
    readonly assignmentId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly generation: number;
    readonly dispatchId: string | null;
    readonly turnId: string | null;
  },
  actual: {
    readonly executionId: string;
    readonly assignmentId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly generation: number;
    readonly dispatchId: string | null;
    readonly turnId: string | null;
  },
) {
  return (
    expected.executionId === actual.executionId &&
    (expected.assignmentId === undefined && actual.assignmentId === undefined
      ? true
      : expected.assignmentId === actual.assignmentId) &&
    (expected.threadId === undefined && actual.threadId === undefined
      ? true
      : expected.threadId === actual.threadId) &&
    expected.generation === actual.generation &&
    expected.dispatchId === actual.dispatchId &&
    expected.turnId === actual.turnId
  );
}

function collaborationResponseAuthorityMatches(
  admission: {
    readonly executionId: string;
    readonly assignmentId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly generation: number;
    readonly dispatchId: string | null;
    readonly turnId: string | null;
  },
  active: {
    readonly executionId: string;
    readonly assignmentId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly generation: number;
    readonly dispatchId: string | null;
    readonly turnId: string | null;
  },
) {
  const strict =
    admission.assignmentId !== undefined ||
    admission.dispatchId !== null ||
    admission.turnId !== null;
  return (
    admission.executionId === active.executionId &&
    (!strict ||
      (admission.assignmentId !== undefined &&
        admission.assignmentId === active.assignmentId &&
        admission.threadId === active.threadId &&
        admission.generation === active.generation &&
        admission.dispatchId === active.dispatchId &&
        admission.turnId === active.turnId))
  );
}

function collaborationRequestEvent(
  command: OrchestrationCommand,
  threadId: ThreadId,
  request: CollaborationRequest,
  action:
    | "created"
    | "responded"
    | "consumed"
    | "superseded"
    | "cancelled"
    | "reopened"
    | "override"
    | "response-rejected",
  updatedAt: string,
): PlannedOrchestrationEvent {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: updatedAt,
      commandId: command.commandId,
    }),
    type: "thread.collaboration-request-updated" as const,
    payload: {
      threadId,
      action,
      request,
      updatedAt,
    },
  };
}

function collaborationQueueEvent(
  command: OrchestrationCommand,
  threadId: ThreadId,
  delivery: Extract<
    OrchestrationCommand,
    { type: "thread.collaboration-request.create" | "thread.collaboration-request.respond" }
  >["delivery"],
  origin: NonNullable<OrchestrationQueuedTurn["origin"]>,
  createdAt: string,
  queuedTurns: ReadonlyArray<OrchestrationQueuedTurn>,
): PlannedOrchestrationEvent {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: createdAt,
      commandId: command.commandId,
    }),
    type: "thread.queued-turn-created" as const,
    payload: {
      threadId,
      queuedTurn: {
        id: delivery.queuedTurnId,
        threadId,
        message: delivery.message,
        // Assigned here too, not only on the enqueue command path: a turn
        // created without a position sorts after every positioned turn, so a
        // later PR-monitor message could overtake a collaboration request.
        queuePosition: nextQueuePosition(queuedTurns),
        ...(delivery.modelSelection !== undefined
          ? { modelSelection: delivery.modelSelection }
          : {}),
        ...(delivery.titleSeed !== undefined ? { titleSeed: delivery.titleSeed } : {}),
        runtimeMode: delivery.runtimeMode,
        interactionMode: delivery.interactionMode,
        origin,
        createdAt,
        updatedAt: createdAt,
        failedAt: null,
        failureMessage: null,
      },
    },
  };
}

function childLifecycleDedupeKey(
  childThreadId: ThreadId,
  lifecycle: ChildThreadLifecycle,
  sourceKey: string,
): string {
  return `child:${childThreadId}:${lifecycle}:${sourceKey}`;
}

type AppendChildLifecycleNotificationInput = {
  readonly readModel: OrchestrationReadModel;
  readonly childThread: OrchestrationThread;
  readonly sourceEvents: ReadonlyArray<PlannedOrchestrationEvent>;
  readonly sourceEvent: PlannedOrchestrationEvent;
  readonly sourceKey: string;
  readonly createdAt: string;
  readonly report?: ChildNudgeUpdate;
  /**
   * Originating provider turn for this lifecycle signal. Compared against the
   * delegation's authorized dispatch turn: a signal from a superseded
   * execution is preserved as history only and must not mutate delegation,
   * decision, wait, or queue state. Absent for parent-side signals (which
   * carry parent authority) and pre-fence callers.
   */
  readonly originTurnId?: string | null;
  readonly authority?: "execution" | "parent";
} & (
  | {
      readonly lifecycle: Exclude<ChildThreadLifecycle, "pr-created">;
    }
  | {
      readonly lifecycle: "pr-created";
      readonly externalActionUrl: string;
    }
);

function appendChildLifecycleNotification(
  input: AppendChildLifecycleNotificationInput,
): DecideOrchestrationCommandResult {
  const sourceResult =
    input.sourceEvents.length === 1 ? input.sourceEvents[0]! : input.sourceEvents;
  const parentThreadId = input.childThread.parentThreadId;
  if (parentThreadId === null || parentThreadId === undefined) {
    return sourceResult;
  }
  const parentThread = input.readModel.threads.find(
    (thread) => thread.id === parentThreadId && thread.deletedAt === null,
  );
  if (!parentThread) {
    return sourceResult;
  }

  const dedupeKey = childLifecycleDedupeKey(input.childThread.id, input.lifecycle, input.sourceKey);
  const delegation = input.childThread.nudging?.delegation;
  // A fenced delegation requires execution proof before anything
  // state-changing: a turn-absent signal (e.g. an unscoped provider runtime
  // error) cannot prove it comes from the authorized execution, so terminal
  // failure/completion stays diagnostic-only and never completes the
  // delegation or wakes the parent. Plain progress history remains allowed.
  // Unfenced (pre-dispatch) work keeps the legacy behavior. Parent-side
  // signals carry parent authority and are never fenced.
  //
  // Supersession is settled before the terminal-failure window, and only then is
  // `wouldMutate` decided: `classifyExecutionProvenance` takes no mutatesState
  // argument precisely so a signal too old to count as terminal failure is not
  // fenced just for asking whether it mutates.
  const provenance =
    input.authority === "parent"
      ? ("authorized" as const)
      : classifyExecutionProvenance({ delegation, claimedTurnId: input.originTurnId });
  const superseded = provenance === "superseded";
  const terminalFailureOutcome: "failed" | "blocked" | null =
    !superseded &&
    delegation?.completedAt === null &&
    (delegation.assignedAt === undefined || input.createdAt >= delegation.assignedAt) &&
    (input.lifecycle === "failed" || input.lifecycle === "blocked")
      ? input.lifecycle
      : null;
  const wouldMutate =
    terminalFailureOutcome !== null ||
    (input.report !== undefined && input.report.kind !== "progress");
  if (provenance === "unproven" && wouldMutate) {
    return sourceResult;
  }
  const terminalReportId = delegation
    ? delegation.dispatchId
      ? `assignment:${input.childThread.id}:${delegation.dispatchId}:${delegation.assignmentId}`
      : `assignment:${input.childThread.id}:${delegation.assignmentId}`
    : null;
  const generatedTerminalReport: ChildNudgeUpdate | undefined =
    terminalFailureOutcome && terminalReportId && delegation
      ? {
          id: terminalReportId,
          assignmentId: delegation.assignmentId,
          ...(delegation.dispatchId ? { dispatchId: delegation.dispatchId } : {}),
          childThreadId: input.childThread.id,
          childTitle: input.childThread.title,
          kind: terminalFailureOutcome,
          summary:
            terminalFailureOutcome === "failed"
              ? "The delegated execution failed. Inspect the child for details."
              : "The delegated execution stopped. Inspect the child before continuing.",
        }
      : undefined;
  const report: ChildNudgeUpdate | undefined = superseded
    ? undefined
    : (input.report ?? generatedTerminalReport);

  const eventBase = withEventBase({
    aggregateKind: "thread",
    aggregateId: parentThreadId,
    occurredAt: input.createdAt,
    commandId: plannedCommandId(input.sourceEvent),
  });
  const notification: ChildLifecycleNotificationEvent =
    input.lifecycle === "pr-created"
      ? {
          ...eventBase,
          causationEventId: input.sourceEvent.eventId,
          type: "thread.child-lifecycle-notified",
          payload: {
            parentThreadId,
            childThreadId: input.childThread.id,
            childTitle: input.childThread.title,
            lifecycle: "pr-created",
            dedupeKey,
            externalAction: { url: input.externalActionUrl },
            createdAt: input.createdAt,
            ...(report ? { report } : {}),
          },
        }
      : {
          ...eventBase,
          causationEventId: input.sourceEvent.eventId,
          type: "thread.child-lifecycle-notified",
          payload: {
            parentThreadId,
            childThreadId: input.childThread.id,
            childTitle: input.childThread.title,
            lifecycle: input.lifecycle,
            dedupeKey,
            createdAt: input.createdAt,
            ...(report ? { report } : {}),
          },
        };
  const shouldQueueNudge =
    report &&
    report.kind !== "progress" &&
    input.childThread.nudging?.delegation?.followUp === "automatic";
  const normalNudge = shouldQueueNudge ? queueChildNudge(parentThread, report, notification) : null;
  const waitReport: ChildNudgeUpdate | null =
    report &&
    (report.kind === "result-available" || report.kind === "failed" || report.kind === "blocked")
      ? report
      : null;
  const waitOutcome: "result-available" | "failed" | "blocked" | null =
    waitReport === null
      ? null
      : waitReport.kind === "result-available" ||
          waitReport.kind === "failed" ||
          waitReport.kind === "blocked"
        ? waitReport.kind
        : null;
  const terminalDelegation =
    terminalFailureOutcome && delegation
      ? {
          ...delegation,
          completedAt: input.createdAt,
          outcome: terminalFailureOutcome,
        }
      : null;
  return [
    ...input.sourceEvents,
    notification,
    ...(terminalDelegation
      ? [
          nudgingMetaEvent(input.childThread, notification, {
            ...input.childThread.nudging,
            delegation: terminalDelegation,
          }),
        ]
      : []),
    ...(report?.kind === "decision-needed" && delegation
      ? [
          nudgingMetaEvent(input.childThread, notification, {
            ...input.childThread.nudging,
            delegation: { ...delegation, decision: report },
          }),
        ]
      : []),
    ...(waitReport &&
    waitOutcome &&
    parentThread.nudging?.wait &&
    !parentThread.nudging.wait.satisfiedAt
      ? [
          nudgingMetaEvent(parentThread, notification, {
            ...parentThread.nudging,
            wait: {
              ...parentThread.nudging.wait,
              assignments: parentThread.nudging.wait.assignments.map((assignment) =>
                assignment.childThreadId === waitReport.childThreadId &&
                assignment.assignmentId === waitReport.assignmentId
                  ? { ...assignment, outcome: waitOutcome }
                  : assignment,
              ),
            },
          }),
        ]
      : []),
    ...(normalNudge ? [normalNudge] : []),
  ];
}

function nudgingMetaEvent(
  thread: OrchestrationThread,
  sourceEvent: PlannedOrchestrationEvent,
  nudging: ThreadNudging,
): PlannedOrchestrationEvent {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: sourceEvent.occurredAt,
      commandId: plannedCommandId(sourceEvent),
    }),
    causationEventId: sourceEvent.eventId,
    type: "thread.meta-updated",
    payload: { threadId: thread.id, nudging, updatedAt: sourceEvent.occurredAt },
  };
}

function childWaitProgressStatus(
  wait: ChildWaitCondition | null | undefined,
  threads: ReadonlyArray<OrchestrationThread>,
): string | undefined {
  if (!wait) return undefined;
  const total = wait.assignments.length;
  const settled = wait.assignments.filter((assignment) => assignment.outcome !== undefined).length;
  const outstanding = wait.assignments.filter((assignment) => assignment.outcome === undefined);
  const outstandingStatus = () => {
    const visible = outstanding.slice(0, 8).map((assignment) => {
      const child = threads.find((candidate) => candidate.id === assignment.childThreadId);
      return `${child?.title ?? "Child"} (${assignment.childThreadId})`;
    });
    return `${visible.join(", ")}${outstanding.length > visible.length ? `, and ${outstanding.length - visible.length} more` : ""}`;
  };
  if (wait.mode === "decisions-only") {
    if (total === 0) return "Wait (decisions-only): decisions and blockers only.";
    if (outstanding.length === 0) {
      return `Wait (decisions-only): ${settled}/${total} settled; assignment results do not satisfy this wait; only decisions or blockers wake it.`;
    }
    return `Wait (decisions-only): ${settled}/${total} settled; still waiting on ${outstandingStatus()} for a decision or blocker.`;
  }
  if (wait.satisfiedAt || childWaitIsSatisfied(wait)) {
    return `Wait (${wait.mode}): ${settled}/${total} settled; condition met.`;
  }
  if (outstanding.length === 0) {
    return `Wait (${wait.mode}): ${settled}/${total} settled; at least one assignment needs attention.`;
  }
  return `Wait (${wait.mode}): ${settled}/${total} settled; still waiting on ${outstandingStatus()}`;
}

function appendDelegationSettlement(input: {
  readonly readModel: OrchestrationReadModel;
  readonly child: OrchestrationThread;
  readonly settlement: NonNullable<ReturnType<typeof settleDelegation>>;
  readonly commandId: CommandId;
  readonly sourceEvents?: ReadonlyArray<PlannedOrchestrationEvent>;
  readonly sourceEvent?: PlannedOrchestrationEvent;
}): DecideOrchestrationCommandResult {
  const delegation = input.child.nudging?.delegation;
  if (!delegation) return input.sourceEvents ?? [];

  const nudging = {
    ...input.child.nudging,
    delegation: {
      ...delegation,
      completedAt: input.settlement.completedAt,
      outcome: input.settlement.outcome,
    },
  };
  const completionEvent: PlannedOrchestrationEvent = input.sourceEvent
    ? nudgingMetaEvent(input.child, input.sourceEvent, nudging)
    : {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: input.child.id,
          occurredAt: input.settlement.completedAt,
          commandId: input.commandId,
        }),
        type: "thread.meta-updated" as const,
        payload: {
          threadId: input.child.id,
          nudging,
          updatedAt: input.settlement.completedAt,
        },
      };
  const sourceEvent = input.sourceEvent ?? completionEvent;
  const settledChild = { ...input.child, nudging };

  return appendChildLifecycleNotification({
    readModel: input.readModel,
    childThread: settledChild,
    sourceEvents: [...(input.sourceEvents ?? []), completionEvent],
    sourceEvent,
    lifecycle: "reported",
    sourceKey: input.settlement.report.id,
    createdAt: input.settlement.completedAt,
    report: input.settlement.report,
    originTurnId: input.settlement.turnId,
  });
}

const hasCanonicalActiveWorktreeOwner = Effect.fn("hasCanonicalActiveWorktreeOwner")(function* (
  readModel: OrchestrationReadModel,
  excludedThreadIds: ThreadId | Iterable<ThreadId>,
  worktreePath: string,
) {
  return Option.isSome(
    yield* findCanonicalActiveWorktreeOwner(readModel, excludedThreadIds, worktreePath),
  );
});

function forkedTitle(title: string): string {
  return title.startsWith(FORK_TITLE_PREFIX) ? title : `${FORK_TITLE_PREFIX}${title}`;
}

function remapForkTurnId(
  sourceTurnId: TurnId | null,
  turnIdBySourceId: Map<string, TurnId>,
): TurnId | null {
  if (sourceTurnId === null) {
    return null;
  }
  const existing = turnIdBySourceId.get(sourceTurnId);
  if (existing) {
    return existing;
  }
  const nextTurnId = crypto.randomUUID() as TurnId;
  turnIdBySourceId.set(sourceTurnId, nextTurnId);
  return nextTurnId;
}

function messageForkEvents(input: {
  readonly command: Extract<OrchestrationCommand, { type: "thread.fork" }>;
  readonly messages: OrchestrationReadModel["threads"][number]["messages"];
}): PlannedOrchestrationEvent[] {
  const turnIdBySourceId = new Map<string, TurnId>();
  return input.messages.map((message) => {
    const nextMessageId = crypto.randomUUID() as MessageId;
    const nextTurnId = remapForkTurnId(message.turnId, turnIdBySourceId);
    return {
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: input.command.threadId,
        occurredAt: message.createdAt,
        commandId: input.command.commandId,
      }),
      type: "thread.message-sent",
      payload: {
        threadId: input.command.threadId,
        messageId: nextMessageId,
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(message.context !== undefined ? { context: message.context } : {}),
        turnId: nextTurnId,
        streaming: false,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    };
  });
}

type MessageSentPayload = Extract<OrchestrationEvent, { type: "thread.message-sent" }>["payload"];
type TurnStartRequestedPayload = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>["payload"];

function buildTurnStartEvents(input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly threadId: MessageSentPayload["threadId"];
  readonly message: Pick<MessageSentPayload, "messageId" | "text" | "attachments"> &
    Pick<Partial<MessageSentPayload>, "context">;
  readonly origin?: MessageSentPayload["origin"];
  readonly context?: MessageSentPayload["context"];
  readonly modelSelection: TurnStartRequestedPayload["modelSelection"];
  readonly titleSeed: TurnStartRequestedPayload["titleSeed"];
  readonly runtimeMode: TurnStartRequestedPayload["runtimeMode"];
  readonly interactionMode: TurnStartRequestedPayload["interactionMode"];
  readonly sourceProposedPlan: TurnStartRequestedPayload["sourceProposedPlan"];
  readonly delegationAssignmentId?: TurnStartRequestedPayload["delegationAssignmentId"];
  readonly delegationDispatchId?: TurnStartRequestedPayload["delegationDispatchId"];
  readonly delegationTransition?: TurnStartRequestedPayload["delegationTransition"];
  readonly executionAuthority?: TurnStartRequestedPayload["executionAuthority"];
  readonly workspaceBinding?: TurnStartRequestedPayload["workspaceBinding"];
  readonly at: string;
}): {
  readonly userMessageEvent: PlannedOrchestrationEvent;
  readonly turnStartRequestedEvent: PlannedOrchestrationEvent;
} {
  const eventBase = () =>
    withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.at,
      commandId: input.commandId,
    });
  const userMessageEvent: PlannedOrchestrationEvent = {
    ...eventBase(),
    type: "thread.message-sent",
    payload: {
      threadId: input.threadId,
      messageId: input.message.messageId,
      role: "user",
      text: input.message.text,
      attachments: input.message.attachments,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      turnId: null,
      streaming: false,
      createdAt: input.at,
      updatedAt: input.at,
    },
  };
  const turnStartRequestedEvent: PlannedOrchestrationEvent = {
    ...eventBase(),
    causationEventId: userMessageEvent.eventId,
    type: "thread.turn-start-requested",
    payload: {
      threadId: input.threadId,
      messageId: input.message.messageId,
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      ...(input.sourceProposedPlan !== undefined
        ? { sourceProposedPlan: input.sourceProposedPlan }
        : {}),
      ...(input.delegationAssignmentId !== undefined
        ? { delegationAssignmentId: input.delegationAssignmentId }
        : {}),
      ...(input.delegationDispatchId !== undefined
        ? { delegationDispatchId: input.delegationDispatchId }
        : {}),
      ...(input.delegationTransition !== undefined
        ? { delegationTransition: input.delegationTransition }
        : {}),
      ...(input.executionAuthority !== undefined
        ? { executionAuthority: input.executionAuthority }
        : {}),
      ...(input.workspaceBinding !== undefined ? { workspaceBinding: input.workspaceBinding } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
      createdAt: input.at,
    },
  };
  return { userMessageEvent, turnStartRequestedEvent };
}

function deriveCrossThreadOrigin(input: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "thread.turn.start" | "thread.queued-turn.create" }
  >;
  readonly sourceThreadId: ThreadId;
  readonly targetThread: OrchestrationReadModel["threads"][number];
  readonly readModel: OrchestrationReadModel;
}): Effect.Effect<MessageSentPayload["origin"], OrchestrationCommandInvariantError> {
  const sourceThread = input.readModel.threads.find((thread) => thread.id === input.sourceThreadId);
  if (!sourceThread) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Cross-thread source thread '${input.sourceThreadId}' does not exist.`,
      }),
    );
  }
  if (input.targetThread.projectId !== sourceThread.projectId) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Cross-thread source '${sourceThread.id}' and target '${input.targetThread.id}' belong to different projects.`,
      }),
    );
  }
  if (sourceThread.session?.activeTurnId === null || sourceThread.session === null) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Cross-thread source thread '${sourceThread.id}' has no active turn.`,
      }),
    );
  }
  const sourceMessageId = sourceThread.session.activeMessageId;
  if (sourceMessageId === undefined) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Cross-thread source thread '${sourceThread.id}' has no authenticated active message.`,
      }),
    );
  }
  const sourceMessage = sourceThread.messages.find((message) => message.id === sourceMessageId);
  if (!sourceMessage || sourceMessage.role !== "user") {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Cross-thread source thread '${sourceThread.id}' has no user message for its active turn.`,
      }),
    );
  }
  return Effect.succeed({
    kind: "cross-thread",
    sourceThreadId: sourceThread.id,
    sourceMessageId: sourceMessage.id,
    sourceThreadTitle: sourceThread.title,
  });
}

/**
 * `CrossThreadOrigin` only lives on the destination message, so the sending
 * thread keeps no record of where its message went. Write the counterpart
 * record to the source thread, anchored to the user message whose turn
 * performed the send, so the timeline can link to the message it produced.
 */
function crossThreadSendRecordedEventFor(input: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "thread.turn.start" | "thread.queued-turn.create" }
  >;
  readonly origin: MessageSentPayload["origin"];
  readonly destinationThread: OrchestrationReadModel["threads"][number];
  readonly destinationMessageId: MessageId;
  readonly readModel: OrchestrationReadModel;
}): CrossThreadSendRecordedEvent | null {
  const origin = input.origin;
  if (origin === undefined || origin.kind !== "cross-thread") {
    return null;
  }
  const sourceThread = input.readModel.threads.find(
    (thread) => thread.id === origin.sourceThreadId,
  );
  if (!sourceThread) {
    return null;
  }
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: sourceThread.id,
      occurredAt: input.command.createdAt,
      commandId: input.command.commandId,
    }),
    type: "thread.cross-thread-send-recorded",
    payload: {
      sourceThreadId: sourceThread.id,
      sourceMessageId: origin.sourceMessageId,
      sourceTurnId: sourceThread.session?.activeTurnId ?? null,
      destinationThreadId: input.destinationThread.id,
      destinationThreadTitle: input.destinationThread.title,
      destinationMessageId: input.destinationMessageId,
      createdAt: input.command.createdAt,
    },
  };
}

function withCrossThreadSendRecord(
  decided: DecideOrchestrationCommandResult,
  record: CrossThreadSendRecordedEvent | null,
): DecideOrchestrationCommandResult {
  if (!record) {
    return decided;
  }
  return [...(Array.isArray(decided) ? decided : [decided]), record];
}

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<ReadonlyArray<PlannedOrchestrationEvent>, OrchestrationCommandInvariantError> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  recordedReportOutcome,
  automaticArchiveGuards,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly recordedReportOutcome?: RecordedReportOutcome;
  /** Consulted only for archives marked `automatic`; see {@link AutomaticArchiveGuard}. */
  readonly automaticArchiveGuards?: ReadonlyArray<AutomaticArchiveGuard>;
}): Effect.fn.Return<DecideOrchestrationCommandResult, OrchestrationCommandInvariantError> {
  switch (command.type) {
    case "thread.validation.request": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.validationRequest?.requestId === command.commandId) {
        return [];
      }
      if (thread.validationRequest !== null && thread.validationRequest !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A validation request is already pending for this thread.",
        });
      }
      if (thread.validationRun !== null && thread.validationRun !== undefined) {
        if (thread.validationRun.requestId === command.commandId) {
          return [];
        }
        if (!isValidationRunTerminal(validationRunEffectiveStatus(thread.validationRun))) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A validation run already exists for this thread.",
          });
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.requestedAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-requested",
        payload: {
          threadId: command.threadId,
          request: {
            requestId: command.commandId,
            threadId: command.threadId,
            scenarios: command.scenarios,
            scope: command.scope,
            requester: command.requester,
            requestedAt: command.requestedAt,
          },
        },
      };
    }

    case "thread.validation.request-failed": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.validationRequest?.requestId !== command.failure.requestId) {
        return [];
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.failure.failedAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-request-failed",
        payload: {
          threadId: command.threadId,
          failure: command.failure,
        },
      };
    }

    case "thread.validation.coordinator-plan": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        thread.validationRun !== null &&
        thread.validationRun !== undefined &&
        thread.validationRun.id !== command.run.id &&
        !isValidationRunTerminal(validationRunEffectiveStatus(thread.validationRun))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A validation run is already planned for this thread.",
        });
      }
      if (thread.validationRun?.id === command.run.id) {
        return [];
      }
      if (thread.validationRequest?.requestId !== command.run.requestId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation plan does not match the pending validation request.",
        });
      }
      if (command.run.threadId !== command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation plan thread does not match the command thread.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-run-planned",
        payload: {
          threadId: command.threadId,
          run: command.run,
        },
      };
    }

    case "thread.validation.lifecycle": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const run = thread.validationRun;
      if (!run || run.id !== command.update.runId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation lifecycle update does not match the active run.",
        });
      }
      const next = yield* Effect.try({
        try: () =>
          transitionValidationRunStatus(run, command.update.status, command.update.updatedAt),
        catch: (cause) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              cause instanceof Error ? cause.message : "Invalid validation lifecycle transition.",
          }),
      });
      if (
        (run.status ?? "planned") === (next.status ?? "planned") &&
        run.updatedAt === next.updatedAt
      ) {
        return [];
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.update.updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-lifecycle-updated",
        payload: {
          threadId: command.threadId,
          update: command.update,
        },
      };
    }

    case "thread.validation.lease.claim": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const run = thread.validationRun;
      if (!run || run.id !== command.runId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation lease claim does not match the active run.",
        });
      }
      if (command.executorId !== command.lease.executorId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation lease executor does not match the claiming executor.",
        });
      }
      const next = yield* Effect.try({
        try: () => claimValidationLease(run, command.lease, command.target, command.claimedAt),
        catch: (cause) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: cause instanceof Error ? cause.message : "Invalid validation lease claim.",
          }),
      });
      if (next === run) return [];
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.claimedAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-lease-claimed",
        payload: {
          threadId: command.threadId,
          runId: command.runId,
          lease: command.lease,
        },
      };
    }

    case "thread.validation.lease.release": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        !thread.validationRun ||
        thread.validationRun.id !== command.runId ||
        thread.validationRun.lease?.id !== command.leaseId
      ) {
        return [];
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.releasedAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-lease-released",
        payload: {
          threadId: command.threadId,
          runId: command.runId,
          leaseId: command.leaseId,
          releasedAt: command.releasedAt,
        },
      };
    }

    case "thread.validation.result.record": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const run = thread.validationRun;
      if (!run || run.id !== command.result.runId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation result does not match the active run.",
        });
      }
      if (!run.lease || run.lease.executorId !== command.result.executorId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation result is not authorized by the active lease.",
        });
      }
      yield* Effect.try({
        try: () => acceptValidationResult(run, command.result),
        catch: (cause) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: cause instanceof Error ? cause.message : "Invalid validation result.",
          }),
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.result.completedAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-result-recorded",
        payload: {
          threadId: command.threadId,
          result: command.result,
        },
      };
    }

    case "chat-archive.import": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.threads.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A chat archive import requires at least one chat.",
        });
      }
      const threadIds = new Set(command.threads.map((thread) => thread.threadId));
      if (threadIds.size !== command.threads.length) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A chat archive import cannot contain duplicate chat identifiers.",
        });
      }
      for (const thread of command.threads) {
        yield* requireThreadAbsent({
          readModel,
          command,
          threadId: thread.threadId,
        });
        if (thread.parentThreadId !== null && !threadIds.has(thread.parentThreadId)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Imported parent '${thread.parentThreadId}' is missing.`,
          });
        }
      }

      const events: PlannedOrchestrationEvent[] = [
        {
          ...withEventBase({
            aggregateKind: "project",
            aggregateId: command.projectId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "project.created",
          payload: {
            projectId: command.projectId,
            kind: "chat-import",
            title: command.title,
            workspaceRoot: command.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      ];
      for (const thread of command.threads) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.threadId,
            occurredAt: thread.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.created",
          payload: {
            threadId: thread.threadId,
            projectId: command.projectId,
            parentThreadId: thread.parentThreadId,
            title: thread.title,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            pendingRuntimeMode: null,
            interactionMode: thread.interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          },
        });
        for (const message of thread.messages) {
          events.push({
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.threadId,
              occurredAt: message.createdAt,
              commandId: command.commandId,
            }),
            type: "thread.message-sent",
            payload: {
              threadId: thread.threadId,
              messageId: message.messageId,
              role: message.role,
              text: message.text,
              turnId: message.turnId,
              streaming: false,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            },
          });
        }
      }
      return events;
    }

    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          kind: "workspace",
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.autoPull !== undefined ? { autoPull: command.autoPull } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      if (
        command.delegation &&
        (!command.parentThreadId || command.delegation.completedAt !== null)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A new delegation requires a parent and an unfinished assignment.",
        });
      }
      // Authoritative mint: every new delegation enters the fenced path with
      // its own execution generation. A caller-presented dispatch is
      // preserved; absent ones are minted here so no creation path can
      // silently produce legacy work.
      const delegation = command.delegation
        ? command.delegation.dispatchId
          ? command.delegation
          : { ...command.delegation, ...mintDispatchRecord(command.delegation.dispatchSequence) }
        : undefined;
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (project.kind === "chat-import") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Imported chat folders are reference-only and cannot create new chats.",
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.parentThreadId !== undefined && command.parentThreadId !== null) {
        const parentThread = yield* requireThread({
          readModel,
          command,
          threadId: command.parentThreadId,
        });
        if (parentThread.deletedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Parent thread '${command.parentThreadId}' is deleted.`,
          });
        }
        if (parentThread.projectId !== command.projectId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Parent thread '${command.parentThreadId}' belongs to a different project.`,
          });
        }
      }
      const createdEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          parentThreadId: command.parentThreadId ?? null,
          ...(delegation ? { nudging: { delegation } } : {}),
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          pendingRuntimeMode: null,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...(command.workspaceBinding !== undefined
            ? { workspaceBinding: command.workspaceBinding }
            : {}),
          ...(command.pullRequest !== undefined ? { pullRequest: command.pullRequest } : {}),
          ...(command.reviewSnapshot !== undefined
            ? { reviewSnapshot: command.reviewSnapshot }
            : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      if (command.parentWait === undefined) return createdEvent;
      const parentThread = readModel.threads.find(
        (thread) => thread.id === command.parentThreadId && thread.deletedAt === null,
      );
      if (!parentThread || !delegation || delegation.followUp !== "automatic") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A creation-time wait requires an automatic child assignment and its parent.",
        });
      }

      let parentWait = command.parentWait;
      if (parentWait) {
        const assignmentIds = new Set<string>();
        if (
          (parentWait.mode !== "any" && parentWait.mode !== "all") ||
          parentWait.assignments.length === 0 ||
          parentWait.assignments.length > 32 ||
          parentWait.satisfiedAt !== undefined
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A creation-time wait requires selected assignments and cannot set completion.",
          });
        }
        let includesCreatedAssignment = false;
        const assignments = [];
        for (const requested of parentWait.assignments) {
          if (assignmentIds.has(requested.childThreadId)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "A creation-time wait cannot contain duplicate child assignments.",
            });
          }
          assignmentIds.add(requested.childThreadId);
          if (requested.outcome !== undefined) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "A creation-time wait cannot supply assignment outcomes.",
            });
          }
          if (requested.childThreadId === command.threadId) {
            if (requested.assignmentId !== delegation.assignmentId) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "A creation-time wait must reference the created child's assignment.",
              });
            }
            includesCreatedAssignment = true;
            assignments.push({
              childThreadId: command.threadId,
              assignmentId: requested.assignmentId,
            });
            continue;
          }
          const existingChild = readModel.threads.find(
            (thread) => thread.id === requested.childThreadId,
          );
          if (
            existingChild &&
            (existingChild.parentThreadId !== parentThread.id ||
              existingChild.deletedAt !== null ||
              existingChild.archivedAt !== null ||
              existingChild.nudging?.delegation?.assignmentId !== requested.assignmentId)
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail:
                "A creation-time wait must reference this parent's current child assignments.",
            });
          }
          const previousAssignment = parentThread.nudging?.wait?.assignments.find(
            (entry) =>
              entry.childThreadId === requested.childThreadId &&
              entry.assignmentId === requested.assignmentId,
          );
          const outcome =
            previousAssignment?.outcome ??
            (existingChild?.nudging?.delegation?.assignmentId === requested.assignmentId
              ? existingChild.nudging.delegation.outcome
              : undefined);
          assignments.push({
            childThreadId: requested.childThreadId,
            assignmentId: requested.assignmentId,
            ...(outcome !== undefined ? { outcome } : {}),
          });
        }
        if (!includesCreatedAssignment) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A creation-time wait must include the created child's assignment.",
          });
        }
        const currentWait = parentThread.nudging?.wait;
        const shouldMerge =
          currentWait !== undefined &&
          currentWait !== null &&
          currentWait.mode === parentWait.mode &&
          currentWait.satisfiedAt === undefined &&
          !childWaitIsSatisfied(currentWait);
        if (shouldMerge) {
          const mergedAssignments = [...currentWait.assignments];
          for (const assignment of assignments) {
            const existingIndex = mergedAssignments.findIndex(
              (entry) =>
                entry.childThreadId === assignment.childThreadId &&
                entry.assignmentId === assignment.assignmentId,
            );
            if (existingIndex < 0) mergedAssignments.push(assignment);
          }
          if (mergedAssignments.length > 32) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "A parent wait cannot contain more than 32 assignments after merging.",
            });
          }
          parentWait = { ...currentWait, assignments: mergedAssignments };
        } else {
          // Absent/satisfied waits are replaced. An unsatisfied wait with a
          // different mode is also replaced so callers never combine
          // incompatible any/all semantics implicitly.
          parentWait = { mode: parentWait.mode, assignments };
        }
      }
      return [
        createdEvent,
        nudgingMetaEvent(parentThread, createdEvent, {
          ...parentThread.nudging,
          wait: parentWait,
        }),
      ];
    }

    case "thread.fork": {
      const sourceThread = yield* requireWritableProjectForThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (sourceThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' is deleted and cannot be forked.`,
        });
      }
      if (
        sourceThread.session?.status === "running" ||
        sourceThread.session?.activeTurnId != null ||
        sourceThread.latestTurn?.state === "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Source run status is 'running'; only provider-finished runs can be forked.",
        });
      }
      const targetMessageIndex = sourceThread.messages.findIndex(
        (message) => message.id === command.targetMessageId,
      );
      const targetMessage =
        targetMessageIndex >= 0 ? sourceThread.messages[targetMessageIndex] : undefined;
      if (!targetMessage) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.targetMessageId}' does not exist on thread '${command.sourceThreadId}'.`,
        });
      }
      if (targetMessage.role !== "assistant") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.targetMessageId}' is not an assistant response and cannot be forked.`,
        });
      }
      if (targetMessage.streaming) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.targetMessageId}' is still streaming and cannot be forked.`,
        });
      }

      const forkedMessages = sourceThread.messages.slice(0, targetMessageIndex + 1);
      const forkCreatedEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created" as const,
        payload: {
          threadId: command.threadId,
          projectId: sourceThread.projectId,
          parentThreadId: command.sourceThreadId,
          title: forkedTitle(sourceThread.title),
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          pendingRuntimeMode: null,
          interactionMode: sourceThread.interactionMode,
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const providerForkRequestedEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: forkCreatedEvent.eventId,
        type: "thread.provider-fork-requested" as const,
        payload: {
          sourceThreadId: command.sourceThreadId,
          threadId: command.threadId,
          targetMessageId: command.targetMessageId,
          targetTurnId: targetMessage.turnId,
          targetTurnCount: assistantTurnCount(forkedMessages),
          createdAt: command.createdAt,
        },
      };
      return [
        forkCreatedEvent,
        providerForkRequestedEvent,
        ...messageForkEvents({ command, messages: forkedMessages }),
      ];
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      const project = readModel.projects.find((entry) => entry.id === thread.projectId);
      const shouldCheckWorktreeOwnership =
        command.cleanupWorktree === true && thread.worktreePath !== null && project !== undefined;
      const hasActiveWorktreeOwner = shouldCheckWorktreeOwnership
        ? yield* hasCanonicalActiveWorktreeOwner(readModel, thread.id, thread.worktreePath)
        : false;
      const worktreeCleanup =
        shouldCheckWorktreeOwnership && !hasActiveWorktreeOwner
          ? {
              cwd: project.workspaceRoot,
              path: thread.worktreePath,
            }
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
          ...(worktreeCleanup !== undefined ? { worktreeCleanup } : {}),
        },
      };
    }

    case "thread.archive": {
      // A refusal decides as nothing, which writes no receipt, so the archiver can retry later.
      if (
        command.automatic === true &&
        !automaticArchiveIsApproved(automaticArchiveGuards, {
          readModel,
          threadId: command.threadId,
        })
      ) {
        return [];
      }
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      const threadsToArchive = collectActiveThreadSubtree(readModel, command.threadId);
      // Cleanup is scheduled by ThreadDeletionReactor after a live PR-state refresh so
      // chats associated while open still clean up once the PR has merged.
      return threadsToArchive.map(
        (thread): PlannedOrchestrationEvent => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.archived",
          payload: {
            threadId: thread.id,
            archivedAt: occurredAt,
            updatedAt: occurredAt,
          },
        }),
      );
    }

    case "thread.unarchive": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      const unarchivedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
      if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
        return [
          unarchivedEvent,
          {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt,
              commandId: command.commandId,
            }),
            type: "thread.session-set",
            payload: {
              threadId: command.threadId,
              session: {
                ...thread.session,
                status: "interrupted",
                activeTurnId: null,
                updatedAt: occurredAt,
              },
            },
          },
        ];
      }
      return unarchivedEvent;
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      // Re-settling an already settled thread must project as a no-op: keep the
      // original settledAt and updatedAt so a duplicate command neither rewinds
      // the settlement nor churns sidebar ordering.
      const alreadySettled = thread.settledOverride === "settled";
      if (threadBlocksSettlement(thread, { now: occurredAt })) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has active work or a pending interaction and cannot settle.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt: thread.settledAt ?? occurredAt,
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      // Idempotent by re-emission (see thread.settle): a thread already pinned
      // active reduces to the same state, so keep updatedAt to avoid reordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      if (
        threadHasQueuedTurnStart(thread, { now: occurredAt }) ||
        threadHasPendingInteraction(thread) ||
        thread.session?.status === "error"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has a queued turn or pending interaction and cannot snooze.`,
        });
      }
      // Negated so an unparseable wake time is rejected too: IsoDateTime is
      // structurally just a string, and NaN fails every comparison, so `<=`
      // would let an unparseable snoozedUntil persist as a permanent snooze.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A snooze must end in the future.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.collaboration-request.create": {
      const sender = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const recipient = yield* requireThread({
        readModel,
        command,
        threadId: command.recipientThreadId,
      });
      const duplicate = collaborationRequestLocation(readModel, command.requestId);
      if (duplicate) {
        return [];
      }
      const transportContextMismatch =
        command.transportContext !== undefined &&
        command.transportContext !== null &&
        (command.transportContext.exchangeId !== command.exchangeId ||
          command.caseId !== command.transportContext.caseId);
      const provenanceMismatch =
        command.monitorProvenance !== undefined &&
        command.monitorProvenance !== null &&
        (command.monitorProvenance.caseId !== command.caseId ||
          command.monitorProvenance.candidateId !== command.candidateRefs[0] ||
          command.monitorProvenance.findingRevisionId !== command.findingRefs[0] ||
          command.monitorProvenance.transportContext?.exchangeId !== command.exchangeId);
      if (
        !executionAuthorityMatches(command.senderAuthority, command.producingExecution) ||
        transportContextMismatch ||
        provenanceMismatch
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "The request authority and acceptance transport context must be immutable and correlated.",
        });
      }
      if (
        command.blocking &&
        (sender.collaborationRequests ?? []).some(
          (request) =>
            request.blocking &&
            request.status === "waiting" &&
            request.producingExecution.executionId === command.producingExecution.executionId &&
            request.producingExecution.generation === command.producingExecution.generation,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Only one blocking collaboration request is allowed per execution generation.",
        });
      }
      const reciprocal = (recipient.collaborationRequests ?? []).find(
        (request) =>
          request.blocking &&
          request.status === "waiting" &&
          request.senderThreadId === recipient.id &&
          request.recipientThreadId === sender.id,
      );
      const directCycle =
        command.blocking &&
        reciprocal !== undefined &&
        (sender.parentThreadId === recipient.id || recipient.parentThreadId === sender.id);
      const status = directCycle
        ? "needs-human"
        : command.blocking
          ? "waiting"
          : "notification-delivered";
      const terminalOutcome = directCycle ? "needs-human" : !command.blocking ? "completed" : null;
      const request: CollaborationRequest = {
        requestId: command.requestId,
        kind: command.kind,
        exchangeId: command.exchangeId,
        senderThreadId: sender.id,
        recipientThreadId: recipient.id,
        blocking: command.blocking,
        ...(command.caseId !== undefined ? { caseId: command.caseId } : {}),
        ...(command.transportContext !== undefined
          ? { transportContext: command.transportContext }
          : {}),
        senderAuthority: command.senderAuthority,
        recipientAuthority: command.recipientAuthority,
        producingExecution: command.producingExecution,
        payloadRef: command.payloadRef,
        candidateRefs: Object.freeze([...command.candidateRefs]),
        findingRefs: Object.freeze([...command.findingRefs]),
        ...(command.monitorProvenance !== undefined
          ? {
              monitorProvenance:
                command.monitorProvenance === null
                  ? null
                  : Object.freeze({
                      ...command.monitorProvenance,
                      transportContext:
                        command.monitorProvenance.transportContext === null
                          ? null
                          : Object.freeze({
                              ...command.monitorProvenance.transportContext,
                            }),
                      workflow: Object.freeze({ ...command.monitorProvenance.workflow }),
                      requiredCoverage: Object.freeze({
                        ...command.monitorProvenance.requiredCoverage,
                        required: Object.freeze([
                          ...command.monitorProvenance.requiredCoverage.required,
                        ]),
                        covered: Object.freeze([
                          ...command.monitorProvenance.requiredCoverage.covered,
                        ]),
                      }),
                      location:
                        command.monitorProvenance.location === null
                          ? null
                          : Object.freeze({ ...command.monitorProvenance.location }),
                    }),
            }
          : {}),
        supersedesRequestId: command.supersedesRequestId ?? null,
        deliveryQueuedTurnId: directCycle ? null : command.delivery.queuedTurnId,
        responseDeliveryQueuedTurnId: null,
        responseRef: null,
        response: null,
        consumedExecution: null,
        status,
        terminalOutcome,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const superseded = command.supersedesRequestId
        ? collaborationRequestLocation(readModel, command.supersedesRequestId)
        : null;
      if (
        command.supersedesRequestId !== undefined &&
        (superseded === null ||
          superseded.request.senderThreadId !== sender.id ||
          superseded.request.recipientThreadId !== recipient.id ||
          !superseded.request.blocking ||
          superseded.request.status !== "waiting")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Only the bound sender may supersede its active blocking request.",
        });
      }
      const events: PlannedOrchestrationEvent[] = [];
      if (superseded !== null) {
        const retired: CollaborationRequest = {
          ...superseded.request,
          status: "superseded",
          terminalOutcome: "superseded",
          updatedAt: command.createdAt,
        };
        for (const threadId of new Set([
          superseded.request.senderThreadId,
          superseded.request.recipientThreadId,
        ])) {
          events.push(
            collaborationRequestEvent(command, threadId, retired, "superseded", command.createdAt),
          );
        }
        for (const [queuedTurnId, ownerThreadId] of [
          [superseded.request.deliveryQueuedTurnId, superseded.request.recipientThreadId],
          [superseded.request.responseDeliveryQueuedTurnId, superseded.request.senderThreadId],
        ] as const) {
          if (queuedTurnId === null) continue;
          events.push({
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: ownerThreadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            type: "thread.queued-turn-deleted" as const,
            payload: {
              threadId: ownerThreadId,
              queuedTurnId,
              deletedAt: command.createdAt,
            },
          });
        }
      }
      events.push(
        collaborationRequestEvent(command, sender.id, request, "created", command.createdAt),
        collaborationRequestEvent(command, recipient.id, request, "created", command.createdAt),
      );
      if (!directCycle) {
        events.push(
          collaborationQueueEvent(
            command,
            recipient.id,
            command.delivery,
            {
              kind: "collaboration-request",
              requestId: request.requestId,
              exchangeId: request.exchangeId,
            },
            command.createdAt,
            recipient.queuedTurns ?? [],
          ),
        );
      }
      return events;
    }

    case "thread.collaboration-request.respond": {
      const location = collaborationRequestLocation(readModel, command.requestId);
      if (!location) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Unknown collaboration request '${command.requestId}'.`,
        });
      }
      const { request } = location;
      if (
        request.recipientThreadId !== command.threadId ||
        request.exchangeId !== command.exchangeId ||
        !collaborationResponseAuthorityMatches(
          request.recipientAuthority,
          command.responderAuthority,
        ) ||
        request.status !== "waiting"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The collaboration request is no longer available for response.",
        });
      }
      const response = {
        responseId: command.responseId,
        requestId: request.requestId,
        exchangeId: request.exchangeId,
        responderThreadId: command.threadId,
        responderAuthority: command.responderAuthority,
        payloadRef: command.payloadRef,
        outcome: command.outcome,
        createdAt: command.createdAt,
      };
      const nextRequest: CollaborationRequest = {
        ...request,
        status: "response-ready",
        responseDeliveryQueuedTurnId: command.delivery.queuedTurnId,
        responseRef: response.responseId,
        response,
        updatedAt: command.createdAt,
      };
      const events: PlannedOrchestrationEvent[] = [
        collaborationRequestEvent(
          command,
          request.senderThreadId,
          nextRequest,
          "responded",
          command.createdAt,
        ),
        collaborationRequestEvent(
          command,
          request.recipientThreadId,
          nextRequest,
          "responded",
          command.createdAt,
        ),
        collaborationQueueEvent(
          command,
          request.senderThreadId,
          command.delivery,
          {
            kind: "collaboration-response",
            requestId: request.requestId,
            responseId: response.responseId,
            exchangeId: request.exchangeId,
          },
          command.createdAt,
          findThreadById(readModel, request.senderThreadId)?.queuedTurns ?? [],
        ),
      ];
      return events;
    }

    case "thread.collaboration-request.consume": {
      const location = collaborationRequestLocation(readModel, command.requestId);
      if (!location || location.request.senderThreadId !== command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The collaboration request is not owned by this thread.",
        });
      }
      const { request } = location;
      const consumedAuthorityMatches =
        request.producingExecution.assignmentId === undefined
          ? request.producingExecution.executionId === command.consumedExecution.executionId &&
            command.consumedExecution.generation > request.producingExecution.generation
          : request.producingExecution.assignmentId === command.consumedExecution.assignmentId &&
            request.producingExecution.threadId === command.consumedExecution.threadId &&
            request.producingExecution.dispatchId === command.consumedExecution.dispatchId &&
            request.producingExecution.executionId === command.consumedExecution.executionId &&
            command.consumedExecution.generation > request.producingExecution.generation &&
            command.consumedExecution.turnId !== null;
      if (
        request.status !== "response-ready" ||
        request.responseRef !== command.responseId ||
        request.response === null ||
        !consumedAuthorityMatches ||
        request.senderThreadId !== command.threadId ||
        (request.producingExecution.threadId !== undefined &&
          request.producingExecution.threadId !== command.threadId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The response cannot be consumed by this execution generation.",
        });
      }
      const nextRequest: CollaborationRequest = {
        ...request,
        status: "consumed",
        consumedExecution: command.consumedExecution,
        terminalOutcome: request.response.outcome,
        updatedAt: command.createdAt,
      };
      const events: PlannedOrchestrationEvent[] = [
        collaborationRequestEvent(
          command,
          command.threadId,
          nextRequest,
          "consumed",
          command.createdAt,
        ),
      ];
      if (request.recipientThreadId !== command.threadId) {
        events.push(
          collaborationRequestEvent(
            command,
            request.recipientThreadId,
            nextRequest,
            "consumed",
            command.createdAt,
          ),
        );
      }
      return events;
    }

    case "thread.collaboration-request.supersede":
    case "thread.collaboration-request.cancel":
    case "thread.collaboration-request.override": {
      const location = collaborationRequestLocation(readModel, command.requestId);
      if (!location) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Unknown collaboration request '${command.requestId}'.`,
        });
      }
      const request = location.request;
      const isSupersede = command.type === "thread.collaboration-request.supersede";
      const isOverride = command.type === "thread.collaboration-request.override";
      const actorIsSender = command.threadId === request.senderThreadId;
      const actorIsRecipient = command.threadId === request.recipientThreadId;
      const actorAuthority = "actorAuthority" in command ? command.actorAuthority : undefined;
      const actorIsBound = isOverride
        ? actorIsSender || actorIsRecipient
        : actorIsSender
          ? actorAuthority !== undefined &&
            executionAuthorityMatches(request.senderAuthority, actorAuthority)
          : actorIsRecipient &&
            actorAuthority !== undefined &&
            executionAuthorityMatches(request.recipientAuthority, actorAuthority);
      if (
        !actorIsBound ||
        (isSupersede && !actorIsSender) ||
        (isSupersede &&
          !readModel.threads.some((thread) =>
            (thread.collaborationRequests ?? []).some(
              (entry) =>
                entry.requestId === command.supersededByRequestId &&
                entry.supersedesRequestId === request.requestId &&
                entry.senderThreadId === request.senderThreadId &&
                entry.recipientThreadId === request.recipientThreadId,
            ),
          ))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "The collaboration request mutation is not authorized for this request authority.",
        });
      }
      const nextRequest: CollaborationRequest = {
        ...request,
        status: isSupersede ? "superseded" : isOverride ? command.outcome : "cancelled",
        terminalOutcome: isSupersede ? "superseded" : isOverride ? command.outcome : "cancelled",
        updatedAt: command.createdAt,
      };
      const events: PlannedOrchestrationEvent[] = [
        collaborationRequestEvent(
          command,
          location.thread.id,
          nextRequest,
          isSupersede ? "superseded" : isOverride ? "override" : "cancelled",
          command.createdAt,
        ),
      ];
      const otherThreadId =
        request.senderThreadId === location.thread.id
          ? request.recipientThreadId
          : request.senderThreadId;
      if (otherThreadId !== location.thread.id) {
        events.push(
          collaborationRequestEvent(
            command,
            otherThreadId,
            nextRequest,
            isSupersede ? "superseded" : isOverride ? "override" : "cancelled",
            command.createdAt,
          ),
        );
      }
      for (const queuedTurnId of [
        request.deliveryQueuedTurnId,
        request.responseDeliveryQueuedTurnId,
      ]) {
        if (queuedTurnId === null) continue;
        const ownerThreadId =
          queuedTurnId === request.deliveryQueuedTurnId
            ? request.recipientThreadId
            : request.senderThreadId;
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: ownerThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.queued-turn-deleted",
          payload: {
            threadId: ownerThreadId,
            queuedTurnId,
            deletedAt: command.createdAt,
          },
        });
      }
      return events;
    }

    case "thread.collaboration-response.delete": {
      const location = collaborationRequestLocation(readModel, command.requestId);
      if (
        !location ||
        !(
          (location.request.senderThreadId === command.threadId &&
            executionAuthorityMatches(location.request.senderAuthority, command.actorAuthority)) ||
          (location.request.recipientThreadId === command.threadId &&
            executionAuthorityMatches(location.request.recipientAuthority, command.actorAuthority))
        ) ||
        location.request.responseRef !== command.responseId ||
        location.request.status !== "response-ready" ||
        location.request.response === null ||
        !["stale", "needs-human"].includes(location.request.response.outcome)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Only the current failed response can be deleted and reopened.",
        });
      }
      const nextRequest: CollaborationRequest = {
        ...location.request,
        status: "waiting",
        responseDeliveryQueuedTurnId: null,
        responseRef: null,
        response: null,
        updatedAt: command.createdAt,
      };
      const events: PlannedOrchestrationEvent[] = [
        collaborationRequestEvent(
          command,
          command.threadId,
          nextRequest,
          "reopened",
          command.createdAt,
        ),
      ];
      if (location.request.recipientThreadId !== command.threadId) {
        events.push(
          collaborationRequestEvent(
            command,
            location.request.recipientThreadId,
            nextRequest,
            "reopened",
            command.createdAt,
          ),
        );
      }
      if (location.request.responseDeliveryQueuedTurnId !== null) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.queued-turn-deleted",
          payload: {
            threadId: location.request.senderThreadId,
            queuedTurnId: location.request.responseDeliveryQueuedTurnId,
            deletedAt: command.createdAt,
          },
        });
      }
      return events;
    }

    case "thread.collaboration-state.clear":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.collaboration-state-cleared",
        payload: {
          threadId: command.threadId,
          clearedAt: command.createdAt,
        },
      };

    case "thread.child-wait.deadline-expire": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const wait = thread.nudging?.wait;
      if (
        !wait ||
        wait.deadlineAt !== command.expectedDeadlineAt ||
        wait.generationId !== command.expectedGenerationId ||
        wait.satisfiedAt ||
        childWaitIsSatisfied(wait)
      ) {
        return [];
      }
      if (Date.parse(command.expiredAt) < Date.parse(wait.deadlineAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A child wait cannot expire before its deadline.",
        });
      }
      if (thread.archivedAt !== null || thread.deletedAt !== null) return [];

      const unsettled = wait.assignments.filter((assignment) => assignment.outcome === undefined);
      if (unsettled.length === 0) return [];
      const expiredWait = {
        ...wait,
        assignments: wait.assignments.map((assignment) =>
          assignment.outcome === undefined
            ? { ...assignment, outcome: "blocked" as const }
            : assignment,
        ),
      };
      const metaEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt: command.expiredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: thread.id,
          nudging: { ...thread.nudging, wait: expiredWait },
          updatedAt: command.expiredAt,
        },
      };
      const notifications: ChildLifecycleNotificationEvent[] = [];
      const reports: ChildNudgeUpdate[] = [];
      for (const assignment of unsettled) {
        const child = readModel.threads.find((entry) => entry.id === assignment.childThreadId);
        const childTitle = child?.title ?? String(assignment.childThreadId);
        const assignmentStartedAt =
          child?.nudging?.delegation?.assignmentId === assignment.assignmentId
            ? child.nudging.delegation.assignedAt
            : undefined;
        const startedAt = assignmentStartedAt ?? wait.deadlineAt;
        const elapsedSeconds = Math.max(
          0,
          Math.floor((Date.parse(command.expiredAt) - Date.parse(startedAt)) / 1_000),
        );
        const reportId = `wait-deadline:${createHash("sha256")
          .update(
            JSON.stringify([
              wait.generationId ?? null,
              wait.deadlineAt,
              assignment.childThreadId,
              assignment.assignmentId,
            ]),
          )
          .digest("hex")}`;
        const report: ChildNudgeUpdate = {
          id: reportId,
          assignmentId: assignment.assignmentId,
          childThreadId: assignment.childThreadId,
          childTitle,
          kind: "blocked",
          wakeReason: "assignment-blocked",
          summary: `Wait deadline expired: ${childTitle} (${assignment.childThreadId}), assignment ${assignment.assignmentId} remained unsettled for ${elapsedSeconds} seconds ${assignmentStartedAt ? "since assignment start" : "since the deadline (assignment start unavailable)"}.`,
        };
        const notification: PlannedOrchestrationEvent = {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: thread.id,
            occurredAt: command.expiredAt,
            commandId: command.commandId,
          }),
          causationEventId: metaEvent.eventId,
          type: "thread.child-lifecycle-notified",
          payload: {
            parentThreadId: thread.id,
            childThreadId: assignment.childThreadId,
            childTitle,
            lifecycle: "blocked",
            dedupeKey: childLifecycleDedupeKey(assignment.childThreadId, "blocked", reportId),
            createdAt: command.expiredAt,
            report,
          },
        };
        reports.push(report);
        notifications.push(notification);
      }

      const parentAfterExpiration = {
        ...thread,
        nudging: { ...thread.nudging, wait: expiredWait },
      };
      const queueEvent = queueChildNudgeBatch(
        parentAfterExpiration,
        reports,
        notifications[notifications.length - 1]!,
      );
      return [metaEvent, ...notifications, queueEvent];
    }

    case "thread.child.wait.prune": {
      const parent = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const wait = parent.nudging?.wait;
      if (!wait) return [];
      const assignments = wait.assignments.filter(
        (entry) =>
          !command.assignments.some(
            (remove) =>
              remove.childThreadId === entry.childThreadId &&
              remove.assignmentId === entry.assignmentId,
          ),
      );
      if (assignments.length === wait.assignments.length) return [];
      const nextWait =
        assignments.length === 0 && wait.mode !== "decisions-only"
          ? null
          : { ...wait, assignments };
      const updatedAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: parent.id,
          nudging: {
            ...parent.nudging,
            wait: nextWait,
          },
          updatedAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        (command.expectedUpdatedAt !== undefined &&
          command.expectedUpdatedAt !== thread.updatedAt) ||
        (command.expectedWorkspaceCwd !== undefined &&
          command.expectedWorkspaceCwd !==
            resolveThreadWorkspaceCwd({ thread, projects: readModel.projects }))
      ) {
        return [];
      }
      const occurredAt = nowIso();
      let childWait = command.childWait;
      if (childWait) {
        if (childWait.deadlineAt !== undefined && !isChildWaitDeadlineAt(childWait.deadlineAt)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A child wait deadline must be a valid ISO date-time.",
          });
        }
        if (
          childWait.satisfiedAt !== undefined ||
          (childWait.mode !== "decisions-only" && childWait.assignments.length === 0) ||
          (childWait.deadlineAt !== undefined && childWait.mode === "decisions-only") ||
          new Set(childWait.assignments.map((entry) => entry.childThreadId)).size !==
            childWait.assignments.length
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "A wait requires distinct child assignments, cannot set its own completion, and deadlines require an assignment-based wait.",
          });
        }
        const assignments = [];
        for (const requested of childWait.assignments) {
          const child = readModel.threads.find((entry) => entry.id === requested.childThreadId);
          if (
            !child ||
            child.parentThreadId !== thread.id ||
            child.deletedAt !== null ||
            child.archivedAt !== null ||
            child.nudging?.delegation?.assignmentId !== requested.assignmentId
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail:
                "Wait conditions must reference current, available assignments of this parent's children.",
            });
          }
          assignments.push({
            childThreadId: child.id,
            assignmentId: requested.assignmentId,
            ...(child.nudging.delegation.outcome
              ? { outcome: child.nudging.delegation.outcome }
              : {}),
          });
        }
        childWait = {
          generationId: command.commandId,
          mode: childWait.mode,
          assignments,
          ...(childWait.deadlineAt !== undefined ? { deadlineAt: childWait.deadlineAt } : {}),
        };
      }
      const metaUpdatedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.childFollowUpPaused !== undefined || command.childWait !== undefined
            ? {
                nudging: {
                  ...thread.nudging,
                  ...(command.childFollowUpPaused !== undefined
                    ? { paused: command.childFollowUpPaused }
                    : {}),
                  ...(command.childWait !== undefined ? { wait: childWait } : {}),
                },
              }
            : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.workspaceBinding !== undefined
            ? { workspaceBinding: command.workspaceBinding }
            : {}),
          ...(command.pullRequest !== undefined ? { pullRequest: command.pullRequest } : {}),
          ...(command.pullRequestSource !== undefined
            ? { pullRequestSource: command.pullRequestSource }
            : {}),
          ...(command.pendingPullRequestAssociation !== undefined
            ? { pendingPullRequestAssociation: command.pendingPullRequestAssociation }
            : command.pullRequest !== undefined
              ? { pendingPullRequestAssociation: null }
              : {}),
          ...(command.pullRequestOwnership !== undefined
            ? { pullRequestOwnership: command.pullRequestOwnership }
            : {}),
          updatedAt: occurredAt,
        },
      };
      const isNewPullRequest =
        command.pullRequest !== undefined &&
        command.pullRequest !== null &&
        command.pullRequest.url !== thread.pullRequest?.url;
      return isNewPullRequest
        ? appendChildLifecycleNotification({
            readModel,
            childThread: thread,
            sourceEvents: [metaUpdatedEvent],
            sourceEvent: metaUpdatedEvent,
            lifecycle: "pr-created",
            sourceKey: command.pullRequest.url,
            createdAt: occurredAt,
            externalActionUrl: command.pullRequest.url,
          })
        : metaUpdatedEvent;
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned",
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt === null ? occurredAt : thread.updatedAt,
        },
      };
      const promotionEvents: PlannedOrchestrationEvent[] = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: thread.pinnedAt == null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.pinnedAt == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not pinned and cannot be reordered.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: thread.pinOrderKey === command.orderKey ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.decouple": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.parentThreadId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not nested under another thread.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.decoupled",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.workspace.handoff": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.continuation.threadId !== command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace continuation '${command.continuation.id}' belongs to thread '${command.continuation.threadId}', not '${command.threadId}'.`,
        });
      }
      if (
        (thread.queuedTurns ?? []).some((queuedTurn) => queuedTurn.id === command.continuation.id)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.continuation.id}' already exists on thread '${command.threadId}'.`,
        });
      }

      const worktreeOwner = yield* findCanonicalActiveWorktreeOwner(
        readModel,
        command.threadId,
        command.worktreePath,
      );
      if (Option.isSome(worktreeOwner)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Worktree '${command.worktreePath}' is already bound to active thread '${worktreeOwner.value}'.`,
        });
      }

      const firstQueuedTurn = thread.queuedTurns?.[0];
      if (firstQueuedTurn !== undefined && firstQueuedTurn.failedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Failed queued turn '${firstQueuedTurn.id}' must be resolved before workspace handoff.`,
        });
      }

      const occurredAt = nowIso();
      const metaUpdatedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...(command.workspaceBinding !== undefined
            ? { workspaceBinding: command.workspaceBinding }
            : {}),
          updatedAt: occurredAt,
        },
      };
      const handoffOrigin = {
        kind: "workspace-handoff",
        role: "marker",
        branch: command.branch,
        worktreePath: command.worktreePath,
        ...(command.workspaceBinding !== undefined
          ? { workspaceBinding: command.workspaceBinding }
          : {}),
      } as const;
      // The marker is the invariant of a handoff: it records the workspace move
      // whether the thread continues on a generated continuation or on a turn
      // the user had already queued.
      const alreadyBoundHere =
        thread.workspaceBinding !== undefined && thread.workspaceBinding !== null
          ? thread.workspaceBinding.canonicalPath ===
              (command.workspaceBinding?.canonicalPath ?? command.worktreePath) &&
            thread.workspaceBinding.branch === command.branch
          : thread.worktreePath === command.worktreePath && thread.branch === command.branch;
      const markerEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.markerMessageId,
          role: "system",
          text: `Moved to ${command.branch} (${command.worktreePath})`,
          origin: handoffOrigin,
          turnId: null,
          streaming: false,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      const events: PlannedOrchestrationEvent[] = [metaUpdatedEvent];
      if (!alreadyBoundHere) {
        events.push(markerEvent);
      }
      if (firstQueuedTurn !== undefined) {
        return events;
      }
      events.push({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.continuation.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-created",
        payload: {
          threadId: command.threadId,
          // The origin is derived here, not trusted from the caller: it is
          // what suppresses the boilerplate bubble, so an untagged or
          // mistagged continuation would re-expose it or render a second
          // divider. It must also agree with the marker it accompanies.
          queuedTurn: {
            ...command.continuation,
            origin: { ...handoffOrigin, role: "continuation" },
            queuePosition: nextQueuePosition(thread.queuedTurns ?? []),
          },
        },
      });
      return events;
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.pull-request.link": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      const existing = (thread.pullRequests ?? []).find((link) =>
        sameThreadPullRequest(link.pullRequest, command.pullRequest),
      );
      const source =
        command.source === "manual" ? (existing?.source ?? command.source) : command.source;
      if (
        existing &&
        existing.source === source &&
        sameThreadPullRequestAssociation(existing.pullRequest, command.pullRequest) &&
        thread.pendingPullRequestAssociation == null
      ) {
        return [];
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pull-request-linked",
        payload: {
          threadId: command.threadId,
          link: {
            pullRequest: command.pullRequest,
            source,
            linkedAt: existing?.linkedAt ?? occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.unlink": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const hasLink = (thread.pullRequests ?? []).some((link) =>
        sameThreadPullRequest(link.pullRequest, command.pullRequest),
      );
      const clearsLegacyPullRequest =
        thread.pullRequest !== null &&
        thread.pullRequest !== undefined &&
        sameThreadPullRequest(thread.pullRequest, command.pullRequest);
      if (!hasLink && !clearsLegacyPullRequest && thread.pendingPullRequestAssociation == null) {
        return [];
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pull-request-unlinked",
        payload: {
          threadId: command.threadId,
          pullRequest: command.pullRequest,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.rekey": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (sameThreadPullRequest(command.previousPullRequest, command.pullRequest)) {
        return [];
      }
      const existing = (thread.pullRequests ?? []).find((link) =>
        sameThreadPullRequest(link.pullRequest, command.previousPullRequest),
      );
      const clearsLegacyPullRequest =
        thread.pullRequest !== null &&
        thread.pullRequest !== undefined &&
        sameThreadPullRequest(thread.pullRequest, command.previousPullRequest);
      if (!existing && !clearsLegacyPullRequest) {
        return [];
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pull-request-rekeyed",
        payload: {
          threadId: command.threadId,
          previousPullRequest: command.previousPullRequest,
          link: {
            pullRequest: command.pullRequest,
            source: existing?.source ?? "manual",
            linkedAt: existing?.linkedAt ?? occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pending-runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pending-runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      yield* requireWritableProjectForThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const targetThread = yield* requireThreadReadyForTurnStart({
        readModel,
        command,
        threadId: command.threadId,
      });
      const origin =
        command.crossThreadSourceThreadId === undefined
          ? command.origin
          : yield* deriveCrossThreadOrigin({
              command,
              sourceThreadId: command.crossThreadSourceThreadId,
              targetThread,
              readModel,
            });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const activeDelegation =
        targetThread.nudging?.delegation?.completedAt === null
          ? targetThread.nudging.delegation
          : undefined;
      if (
        isInitialDelegationDispatch(activeDelegation) &&
        command.message.messageId !== activeDelegation?.assignmentId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: INITIAL_ASSIGNMENT_REQUIRED_DETAIL,
        });
      }
      const executionAuthority =
        activeDelegation?.dispatchId !== undefined &&
        activeDelegation.dispatchSequence !== undefined &&
        activeDelegation.dispatchTurnId !== undefined &&
        activeDelegation.dispatchTurnId !== null
          ? {
              executionId: `thread:${targetThread.id}`,
              assignmentId: activeDelegation.assignmentId,
              threadId: targetThread.id,
              generation: activeDelegation.dispatchSequence,
              dispatchId: activeDelegation.dispatchId,
              turnId: activeDelegation.dispatchTurnId,
            }
          : undefined;
      if (activeDelegation?.decision) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: CHILD_DECISION_BLOCKED_DETAIL,
        });
      }
      const execution =
        activeDelegation?.dispatchTurnId != null
          ? transitionDelegationExecution(activeDelegation, "continued")
          : null;
      const turnDelegation = execution?.delegation ?? activeDelegation;
      const { userMessageEvent, turnStartRequestedEvent } = buildTurnStartEvents({
        commandId: command.commandId,
        threadId: command.threadId,
        message: {
          messageId: command.message.messageId,
          text: command.message.text,
          attachments: command.message.attachments,
        },
        ...(origin !== undefined ? { origin } : {}),
        ...(command.message.context !== undefined ? { context: command.message.context } : {}),
        modelSelection: command.modelSelection,
        titleSeed: command.titleSeed,
        runtimeMode: targetThread.runtimeMode,
        interactionMode: targetThread.interactionMode,
        sourceProposedPlan,
        ...(turnDelegation?.dispatchId
          ? {
              delegationAssignmentId: turnDelegation.assignmentId,
              delegationDispatchId: turnDelegation.dispatchId,
              delegationTransition: turnDelegation.dispatchReason ?? "assigned",
            }
          : {}),
        ...(executionAuthority !== undefined ? { executionAuthority } : {}),
        ...(command.workspaceBinding !== undefined
          ? { workspaceBinding: command.workspaceBinding }
          : {}),
        at: command.createdAt,
      });
      const occurredAt = command.createdAt;
      const lifecycleEvents: PlannedOrchestrationEvent[] = [];
      if (threadHasSettlementOverride(targetThread)) {
        lifecycleEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: occurredAt,
          },
        });
      }
      if (threadIsSnoozed(targetThread)) {
        lifecycleEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: occurredAt,
          },
        });
      }
      const delegationEvents =
        execution && targetThread.nudging
          ? [
              nudgingMetaEvent(targetThread, turnStartRequestedEvent, {
                ...targetThread.nudging,
                delegation: execution.delegation,
              }),
            ]
          : [];
      const workspaceBindingEvent =
        command.workspaceBinding !== undefined &&
        (targetThread.workspaceBinding?.generation !== command.workspaceBinding.generation ||
          targetThread.workspaceBinding?.canonicalPath !== command.workspaceBinding.canonicalPath)
          ? [
              {
                ...withEventBase({
                  aggregateKind: "thread",
                  aggregateId: command.threadId,
                  occurredAt,
                  commandId: command.commandId,
                }),
                type: "thread.meta-updated" as const,
                payload: {
                  threadId: command.threadId,
                  branch: command.workspaceBinding.branch,
                  worktreePath: command.workspaceBinding.worktreePath,
                  workspaceBinding: command.workspaceBinding,
                  updatedAt: occurredAt,
                },
              },
            ]
          : [];
      return withCrossThreadSendRecord(
        appendChildLifecycleNotification({
          readModel,
          childThread: targetThread,
          sourceEvents: [
            ...workspaceBindingEvent,
            userMessageEvent,
            turnStartRequestedEvent,
            ...delegationEvents,
            ...lifecycleEvents,
          ],
          sourceEvent: turnStartRequestedEvent,
          lifecycle: "started",
          sourceKey: command.message.messageId,
          createdAt: command.createdAt,
          authority: "parent",
        }),
        crossThreadSendRecordedEventFor({
          command,
          origin,
          destinationThread: targetThread,
          destinationMessageId: command.message.messageId,
          readModel,
        }),
      );
    }

    case "thread.queued-turn.create": {
      yield* requireWritableProjectForThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if ((thread.queuedTurns ?? []).some((queuedTurn) => queuedTurn.id === command.queuedTurnId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.queuedTurnId}' already exists on thread '${command.threadId}'.`,
        });
      }
      const origin =
        command.crossThreadSourceThreadId === undefined
          ? command.origin
          : yield* deriveCrossThreadOrigin({
              command,
              sourceThreadId: command.crossThreadSourceThreadId,
              targetThread: thread,
              readModel,
            });
      const queuedTurn: OrchestrationQueuedTurn = {
        id: command.queuedTurnId,
        threadId: command.threadId,
        message: command.assignment
          ? {
              ...command.message,
              text: `${command.message.text}\n\nT3 delegated assignment: ${command.message.messageId}. Use this exact assignmentId in report_to_parent. Results are reported automatically; report early decisions with a question and whether you can continue.`,
            }
          : command.message,
        ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
        ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        ...(command.sourceProposedPlan !== undefined
          ? { sourceProposedPlan: command.sourceProposedPlan }
          : {}),
        ...(origin !== undefined ? { origin } : {}),
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        // Appending must never reorder the existing queue: the new turn takes
        // the next position rather than sorting by its own creation time.
        queuePosition: nextQueuePosition(thread.queuedTurns ?? []),
        failedAt: null,
        failureMessage: null,
      };
      const queuedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-created",
        payload: {
          threadId: command.threadId,
          queuedTurn,
        },
      };
      const crossThreadSendRecord = crossThreadSendRecordedEventFor({
        command,
        origin,
        destinationThread: thread,
        // The queued turn's message id is reused verbatim when the turn
        // dispatches, so this is the id the sent message will carry.
        destinationMessageId: command.message.messageId,
        readModel,
      });
      if (!command.assignment && !command.respondToReportId) {
        return withCrossThreadSendRecord(queuedEvent, crossThreadSendRecord);
      }
      const delegation = thread.nudging?.delegation;
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        !thread.parentThreadId ||
        (command.crossThreadSourceThreadId !== undefined &&
          command.crossThreadSourceThreadId !== thread.parentThreadId) ||
        (command.assignment && command.respondToReportId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Tracked work requires an available child and its parent; assignment and response are exclusive.",
        });
      }
      if (command.assignment) {
        if (
          delegation?.completedAt === null ||
          delegation?.decision ||
          thread.session?.activeTurnId != null ||
          threadHasPendingInteraction(thread) ||
          (thread.queuedTurns?.length ?? 0) > 0
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              "Finish the current assignment and resolve its decision before assigning new work.",
          });
        }
        const parentThread = readModel.threads.find(
          (entry) => entry.id === thread.parentThreadId && entry.deletedAt === null,
        );
        const parentWait = parentThread?.nudging?.wait;
        const shouldRetargetWait =
          parentWait !== undefined &&
          parentWait !== null &&
          parentWait.satisfiedAt === undefined &&
          !childWaitIsSatisfied(parentWait) &&
          parentWait.assignments.some(
            (entry) =>
              entry.childThreadId === thread.id &&
              entry.assignmentId === delegation?.assignmentId &&
              entry.outcome === undefined,
          );
        const assignmentEvents: PlannedOrchestrationEvent[] = [
          queuedEvent,
          nudgingMetaEvent(thread, queuedEvent, {
            ...thread.nudging,
            delegation: {
              assignmentId: command.message.messageId,
              ...mintDispatchRecord(null),
              followUp: command.assignment.followUp,
              completedAt: null,
              assignedAt: command.createdAt,
              decision: null,
            },
          }),
        ];
        if (shouldRetargetWait && parentThread && parentWait) {
          assignmentEvents.push(
            nudgingMetaEvent(parentThread, queuedEvent, {
              ...parentThread.nudging,
              wait: {
                ...parentWait,
                assignments: parentWait.assignments.map((entry) =>
                  entry.childThreadId === thread.id &&
                  entry.assignmentId === delegation?.assignmentId &&
                  entry.outcome === undefined
                    ? { ...entry, assignmentId: command.message.messageId }
                    : entry,
                ),
              },
            }),
          );
        }
        return withCrossThreadSendRecord(assignmentEvents, crossThreadSendRecord);
      }
      if (
        !delegation?.decision ||
        delegation.pendingResponse ||
        delegation.assignmentId !== command.assignmentId ||
        delegation.decision.id !== command.respondToReportId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The decision is no longer current. Refresh the child before responding.",
        });
      }
      return withCrossThreadSendRecord(
        [
          queuedEvent,
          nudgingMetaEvent(thread, queuedEvent, {
            ...thread.nudging,
            delegation: {
              ...delegation,
              decision: null,
              pendingResponse: { queuedTurnId: queuedTurn.id, report: delegation.decision },
            },
          }),
        ],
        crossThreadSendRecord,
      );
    }

    case "thread.queued-turn.update": {
      const { queuedTurn } = yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      if (queuedTurn.origin?.kind === "child-nudge" && command.text !== queuedTurn.message.text) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Generated child updates cannot be edited; dismiss or retry them.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-updated",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          text: command.text,
          ...(command.origin !== undefined ? { origin: command.origin } : {}),
          ...(command.context !== undefined ? { context: command.context } : {}),
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.queued-turn.delete": {
      const { thread, queuedTurn } = yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      const deleted: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.deletedAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-deleted",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          deletedAt: command.deletedAt,
        },
      };
      const delegation = thread.nudging?.delegation;
      if (delegation?.pendingResponse?.queuedTurnId === queuedTurn.id) {
        return [
          deleted,
          nudgingMetaEvent(thread, deleted, {
            ...thread.nudging,
            delegation: {
              ...delegation,
              decision: delegation.decision ?? delegation.pendingResponse.report,
              pendingResponse: null,
            },
          }),
        ];
      }
      if (
        delegation?.completedAt === null &&
        delegation.assignmentId === queuedTurn.message.messageId
      ) {
        return appendChildLifecycleNotification({
          readModel,
          childThread: thread,
          sourceEvents: [deleted],
          sourceEvent: deleted,
          lifecycle: "blocked",
          sourceKey: `cancel-assignment:${delegation.assignmentId}`,
          createdAt: command.deletedAt,
          authority: "parent",
        });
      }
      return deleted;
    }

    case "thread.queued-turn.dispatch": {
      yield* requireWritableProjectForThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const { thread: targetThread, queuedTurn } = yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      yield* requireThreadReadyForTurnStart({
        readModel,
        command,
        threadId: command.threadId,
      });
      const isNudge = queuedTurn.origin?.kind === "child-nudge";
      const followUp = isNudge
        ? evaluateChildFollowUp(
            targetThread,
            queuedTurn,
            new Map(readModel.threads.map((thread) => [thread.id, thread])),
            command.dispatchedAt,
          )
        : null;
      if (followUp?.reason) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: followUp.reason,
        });
      }
      if (followUp && followUp.updates.length === 0) {
        return {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: targetThread.id,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.queued-turn-deleted",
          payload: {
            threadId: targetThread.id,
            queuedTurnId: queuedTurn.id,
            deletedAt: command.dispatchedAt,
          },
        };
      }
      if (
        isNudge &&
        (isAutomaticChildNudgeBlocked(targetThread) || threadHasPendingInteraction(targetThread))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Automatic child follow-up is paused or awaiting interaction.",
        });
      }
      if (queuedTurn.failedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.queuedTurnId}' is failed and must be edited before dispatch.`,
        });
      }
      const nudging = targetThread.nudging;
      const activeDelegation =
        nudging?.delegation?.completedAt === null ? nudging.delegation : undefined;
      if (
        isInitialDelegationDispatch(activeDelegation) &&
        queuedTurn.message.messageId !== activeDelegation?.assignmentId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: INITIAL_ASSIGNMENT_REQUIRED_DETAIL,
        });
      }
      const responseDispatched = activeDelegation?.pendingResponse?.queuedTurnId === queuedTurn.id;
      if (activeDelegation?.decision && !responseDispatched) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: CHILD_DECISION_BLOCKED_DETAIL,
        });
      }
      const execution =
        activeDelegation?.dispatchTurnId != null
          ? transitionDelegationExecution(activeDelegation, "continued")
          : null;
      const turnDelegation = execution?.delegation ?? activeDelegation;
      const events: PlannedOrchestrationEvent[] = [];
      if (queuedTurn.modelSelection !== undefined) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.meta-updated",
          payload: {
            threadId: command.threadId,
            modelSelection: queuedTurn.modelSelection,
            updatedAt: command.dispatchedAt,
          },
        });
      }
      if (!isNudge && targetThread.runtimeMode !== queuedTurn.runtimeMode) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.runtime-mode-set",
          payload: {
            threadId: command.threadId,
            runtimeMode: queuedTurn.runtimeMode,
            updatedAt: command.dispatchedAt,
          },
        });
      }
      if (!isNudge && targetThread.interactionMode !== queuedTurn.interactionMode) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.interaction-mode-set",
          payload: {
            threadId: command.threadId,
            interactionMode: queuedTurn.interactionMode,
            updatedAt: command.dispatchedAt,
          },
        });
      }
      // Persist an isolated workspace binding admitted for this dispatch. The
      // turn-start-requested payload below carries the binding for provenance,
      // but no projector applies it to the thread; without this meta-updated
      // event the provider would keep executing in the stale worktree while
      // the claimed isolated workspace sits unused.
      if (
        command.workspaceBinding !== undefined &&
        (targetThread.workspaceBinding?.generation !== command.workspaceBinding.generation ||
          targetThread.workspaceBinding?.canonicalPath !== command.workspaceBinding.canonicalPath)
      ) {
        events.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.dispatchedAt,
            commandId: command.commandId,
          }),
          type: "thread.meta-updated",
          payload: {
            threadId: command.threadId,
            branch: command.workspaceBinding.branch,
            worktreePath: command.workspaceBinding.worktreePath,
            workspaceBinding: command.workspaceBinding,
            updatedAt: command.dispatchedAt,
          },
        });
      }
      const turnOrigin =
        followUp && queuedTurn.origin?.kind === "child-nudge"
          ? { ...queuedTurn.origin, updates: followUp.updates }
          : queuedTurn.origin;
      const { userMessageEvent, turnStartRequestedEvent } = buildTurnStartEvents({
        commandId: command.commandId,
        threadId: command.threadId,
        message: {
          messageId: queuedTurn.message.messageId,
          text: followUp
            ? childNudgePrompt(
                followUp.updates,
                childWaitProgressStatus(nudging?.wait, readModel.threads),
              )
            : queuedTurn.message.text,
          attachments: queuedTurn.message.attachments,
        },
        ...(turnOrigin !== undefined ? { origin: turnOrigin } : {}),
        // Nudge follow-ups synthesize their own prompt; queued user text keeps its context.
        ...(followUp || queuedTurn.message.context === undefined
          ? {}
          : { context: queuedTurn.message.context }),
        modelSelection: queuedTurn.modelSelection,
        titleSeed: queuedTurn.titleSeed,
        runtimeMode: isNudge ? targetThread.runtimeMode : queuedTurn.runtimeMode,
        interactionMode: isNudge ? targetThread.interactionMode : queuedTurn.interactionMode,
        sourceProposedPlan: queuedTurn.sourceProposedPlan,
        workspaceBinding: command.workspaceBinding ?? targetThread.workspaceBinding ?? undefined,
        ...(turnDelegation?.dispatchId
          ? {
              delegationAssignmentId: turnDelegation.assignmentId,
              delegationDispatchId: turnDelegation.dispatchId,
              delegationTransition: turnDelegation.dispatchReason ?? "assigned",
            }
          : {}),
        at: command.dispatchedAt,
      });
      const dispatchedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.dispatchedAt,
          commandId: command.commandId,
        }),
        causationEventId: turnStartRequestedEvent.eventId,
        type: "thread.queued-turn-dispatched",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          messageId: queuedTurn.message.messageId,
          dispatchedAt: command.dispatchedAt,
        },
      };
      const waitSatisfied =
        isNudge &&
        followUp &&
        nudging?.wait &&
        !nudging.wait.satisfiedAt &&
        childWaitIsSatisfiedByUpdates(nudging.wait, followUp.updates);
      let nextNudging: ThreadNudging | null = null;
      if (execution && nudging) {
        nextNudging = { ...nudging, delegation: execution.delegation };
      } else if (responseDispatched && nudging?.delegation) {
        nextNudging = {
          ...nudging,
          delegation: { ...nudging.delegation, pendingResponse: null },
        };
      }
      if (waitSatisfied && nudging?.wait) {
        nextNudging = {
          ...(nextNudging ?? nudging),
          wait: { ...nudging.wait, satisfiedAt: command.dispatchedAt },
        };
      }
      const nudgingEvents =
        nextNudging === null ? [] : [nudgingMetaEvent(targetThread, dispatchedEvent, nextNudging)];
      return appendChildLifecycleNotification({
        readModel,
        childThread: targetThread,
        sourceEvents: [
          ...events,
          userMessageEvent,
          turnStartRequestedEvent,
          dispatchedEvent,
          ...nudgingEvents,
        ],
        sourceEvent: turnStartRequestedEvent,
        lifecycle: "started",
        sourceKey: queuedTurn.message.messageId,
        createdAt: command.dispatchedAt,
        authority: "parent",
      });
    }

    case "thread.queued-turn.fail": {
      yield* requireQueuedTurn({
        readModel,
        command,
        threadId: command.threadId,
        queuedTurnId: command.queuedTurnId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.failedAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-failed",
        payload: {
          threadId: command.threadId,
          queuedTurnId: command.queuedTurnId,
          failureMessage: command.failureMessage,
          failedAt: command.failedAt,
        },
      };
    }

    case "thread.queue.hold": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Holding an empty or already-held queue is a no-op rather than an error:
      // crash recovery sweeps every thread it sees, and repeat boots must not
      // fail on the state a previous boot already wrote.
      if ((thread.queuedTurns ?? []).length === 0 || thread.queueHeldAt != null) {
        return [];
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.heldAt,
          commandId: command.commandId,
        }),
        type: "thread.queue-held",
        payload: {
          threadId: command.threadId,
          heldAt: command.heldAt,
        },
      };
    }

    case "thread.queue.release": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.queueHeldAt == null) {
        return [];
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.releasedAt,
          commandId: command.commandId,
        }),
        type: "thread.queue-released",
        payload: {
          threadId: command.threadId,
          releasedAt: command.releasedAt,
        },
      };
    }

    case "thread.queued-turn.reorder": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const queuedTurns = thread.queuedTurns ?? [];
      const current = new Set(queuedTurns.map((queuedTurn) => queuedTurn.id));
      const requested = new Set(command.orderedQueuedTurnIds);
      // The order must be a permutation of the live queue. A partial order
      // would silently drop the omitted turns' positions, so the next boot
      // would rebuild a different order than the user last saw.
      if (
        requested.size !== current.size ||
        current.size !== command.orderedQueuedTurnIds.length ||
        !command.orderedQueuedTurnIds.every((queuedTurnId) => current.has(queuedTurnId))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Reorder for thread '${command.threadId}' must list every queued turn exactly once.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.reorderedAt,
          commandId: command.commandId,
        }),
        type: "thread.queued-turn-reordered",
        payload: {
          threadId: command.threadId,
          orderedQueuedTurnIds: command.orderedQueuedTurnIds,
          reorderedAt: command.reorderedAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const turnId =
        command.turnId ??
        targetThread.session?.activeTurnId ??
        (targetThread.latestTurn?.state === "running" ? targetThread.latestTurn.turnId : undefined);
      const interrupted: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(turnId !== undefined ? { turnId } : {}),
          createdAt: command.createdAt,
        },
      };
      return targetThread.nudging?.paused === true
        ? interrupted
        : [
            interrupted,
            nudgingMetaEvent(targetThread, interrupted, { ...targetThread.nudging, paused: true }),
          ];
    }

    case "thread.turn.steer": {
      yield* requireWritableProjectForThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const { thread: targetThread, turnId: activeTurnId } = yield* requireThreadWithInFlightTurn({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.turnId !== undefined && command.turnId !== activeTurnId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            `Turn '${command.turnId}' is no longer the active turn on thread ` +
            `'${command.threadId}'. Reissue the steer against turn '${activeTurnId}' or send a new turn.`,
        });
      }
      const occurredAt = command.createdAt;
      const eventBase = () =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        });
      const userMessageEvent: PlannedOrchestrationEvent = {
        ...eventBase(),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.origin !== undefined ? { origin: command.origin } : {}),
          turnId: activeTurnId,
          streaming: false,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      const steerRequestedEvent: PlannedOrchestrationEvent = {
        ...eventBase(),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-steer-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          turnId: activeTurnId,
          createdAt: occurredAt,
        },
      };
      const lifecycleEvents: PlannedOrchestrationEvent[] = [];
      if (threadHasSettlementOverride(targetThread)) {
        lifecycleEvents.push({
          ...eventBase(),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: occurredAt,
          },
        });
      }
      if (threadIsSnoozed(targetThread)) {
        lifecycleEvents.push({
          ...eventBase(),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: occurredAt,
          },
        });
      }
      return [userMessageEvent, steerRequestedEvent, ...lifecycleEvents];
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const stopped: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
      return thread.nudging?.paused === true
        ? stopped
        : [stopped, nudgingMetaEvent(thread, stopped, { ...thread.nudging, paused: true })];
    }

    case "thread.validation-run.plan": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        thread.validationRun !== null &&
        thread.validationRun !== undefined &&
        validationTargetEquals(thread.validationRun.target, command.target)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A validation run is already planned for this thread.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-run-planned",
        payload: {
          threadId: command.threadId,
          run: planValidationRun({
            id: command.runId,
            threadId: command.threadId,
            executorId: command.executorId,
            target: command.target,
            requestedAt: command.createdAt,
          }),
        },
      };
    }

    case "thread.validation-gate.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (!thread.validationRun || thread.validationRun.id !== command.runId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation gate update does not match the active validation run.",
        });
      }
      if (
        thread.validationRun.executorId !== command.executorId ||
        thread.validationRun.lease?.id !== command.leaseId ||
        !validationTargetEquals(thread.validationRun.target, command.target)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Validation gate update is not owned by the active lease and target executor.",
        });
      }
      const validationRun = thread.validationRun;
      const run = yield* Effect.try({
        try: () =>
          transitionValidationGate(
            validationRun,
            {
              gateId: command.gateId,
              status: command.status,
              command: command.command,
              startedAt: command.startedAt,
              completedAt: command.completedAt,
              exitCode: command.exitCode,
              outputRef: command.outputRef,
              blockerReason: command.blockerReason,
              diagnostics: command.diagnostics,
            },
            command.createdAt,
          ),
        catch: (cause) =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: cause instanceof Error ? cause.message : "Invalid validation gate transition.",
          }),
      });
      const gate = run.gates.find((candidate) => candidate.id === command.gateId);
      if (!gate) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Validation gate '${command.gateId}' was not produced by the transition.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.validation-gate-updated",
        payload: {
          threadId: command.threadId,
          runId: command.runId,
          gate,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.expectedActiveTurnId !== undefined &&
        thread.session?.activeTurnId !== command.expectedActiveTurnId
      ) {
        return [];
      }
      const sessionSetEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      const sourceEvents: PlannedOrchestrationEvent[] = [sessionSetEvent];
      // Initial fenced executions require the accepted assignment message.
      // Legacy delegations enter the fenced path here; subsequent provider
      // turns rotate the dispatch, and retries preserve the existing binding.
      const bindingDelegation = thread.nudging?.delegation;
      const prevActiveTurn = thread.session?.activeTurnId ?? null;
      const nextActiveTurn = command.session?.activeTurnId ?? null;
      if (
        bindingDelegation &&
        bindingDelegation.completedAt === null &&
        (!isInitialDelegationDispatch(bindingDelegation) ||
          thread.messages.findLast((message) => message.role === "user")?.id ===
            bindingDelegation.assignmentId) &&
        nextActiveTurn !== null &&
        nextActiveTurn !== prevActiveTurn
      ) {
        const boundTurn = (bindingDelegation.dispatchTurnId as string | null | undefined) ?? null;
        if (boundTurn === null) {
          const bindableDelegation = bindingDelegation.dispatchId
            ? bindingDelegation
            : { ...bindingDelegation, ...mintDispatchRecord(bindingDelegation.dispatchSequence) };
          sourceEvents.push(
            nudgingMetaEvent(thread, sessionSetEvent, {
              ...thread.nudging,
              delegation: bindDelegationExecution(bindableDelegation, nextActiveTurn),
            }),
          );
        } else if (boundTurn !== nextActiveTurn) {
          const replacement = transitionDelegationExecution(bindingDelegation, "replaced");
          sourceEvents.push(
            nudgingMetaEvent(thread, sessionSetEvent, {
              ...thread.nudging,
              delegation: bindDelegationExecution(replacement.delegation, nextActiveTurn),
            }),
          );
          if (replacement.retiredPendingResponseQueuedTurnId !== null) {
            sourceEvents.push({
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: thread.id,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              causationEventId: sessionSetEvent.eventId,
              type: "thread.queued-turn-deleted",
              payload: {
                threadId: thread.id,
                queuedTurnId: replacement.retiredPendingResponseQueuedTurnId,
                deletedAt: command.createdAt,
              },
            });
          }
        }
      }
      if (nextActiveTurn !== null && nextActiveTurn !== prevActiveTurn) {
        const responseReady = (thread.collaborationRequests ?? []).find(
          (request) =>
            request.status === "response-ready" &&
            request.response !== null &&
            request.responseDeliveryQueuedTurnId !== null,
        );
        if (responseReady?.response) {
          const response = responseReady.response;
          sourceEvents.push(
            collaborationRequestEvent(
              command,
              thread.id,
              {
                ...responseReady,
                status: "consumed",
                consumedExecution: {
                  executionId: command.session.providerInstanceId ?? thread.id,
                  generation: responseReady.producingExecution.generation + 1,
                  dispatchId: responseReady.producingExecution.dispatchId,
                  turnId: nextActiveTurn,
                },
                terminalOutcome: response.outcome,
                updatedAt: command.createdAt,
              },
              "consumed",
              command.createdAt,
            ),
          );
        }
      }
      if (command.session?.status === "running" && threadHasSettlementOverride(thread)) {
        sourceEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }

      const completedTurnId =
        thread.session?.status === "running" &&
        thread.session.activeTurnId !== null &&
        command.session?.activeTurnId === null
          ? thread.session.activeTurnId
          : null;
      const lifecycle =
        completedTurnId === null
          ? null
          : command.session.status === "ready"
            ? "completed"
            : command.session.status === "error"
              ? "failed"
              : command.session.status === "stopped"
                ? "blocked"
                : null;
      if (lifecycle === null || completedTurnId === null) {
        return sourceEvents.length === 1 ? sessionSetEvent : sourceEvents;
      }
      // Delegated results are reported after checkpoint finalization, not session-idle publication.
      if (thread.nudging?.delegation && lifecycle === "completed") {
        return sourceEvents;
      }
      return appendChildLifecycleNotification({
        readModel,
        childThread: thread,
        sourceEvents,
        sourceEvent: sessionSetEvent,
        lifecycle,
        sourceKey: completedTurnId,
        createdAt: command.createdAt,
        originTurnId: completedTurnId,
      });
    }

    case "thread.dispatch.replace": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const delegation = thread.nudging?.delegation;
      if (!thread.parentThreadId || !delegation || thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Replacing execution requires a delegated child assignment.",
        });
      }
      if (delegation.completedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The assignment already completed; replacement is not allowed.",
        });
      }
      const activeDispatch = delegation.dispatchId ?? null;
      const expectedDispatch = command.expectedDispatchId ?? null;
      if (activeDispatch !== expectedDispatch) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "The active execution changed since this replacement was prepared; refresh and retry with the current dispatch.",
        });
      }
      const pendingResponseId = delegation.pendingResponse?.queuedTurnId ?? null;
      const unrelatedQueuedTurns = (thread.queuedTurns ?? []).filter(
        (queuedTurn) => queuedTurn.id !== pendingResponseId,
      );
      if (unrelatedQueuedTurns.length > 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Replacement requires an empty child queue apart from its pending decision answer.",
        });
      }
      if ((thread.queuedTurns ?? []).some((queuedTurn) => queuedTurn.id === command.queuedTurnId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Queued turn '${command.queuedTurnId}' already exists on thread '${command.threadId}'.`,
        });
      }
      const replacement = transitionDelegationExecution(delegation, "replaced");
      const metaUpdated: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          nudging: {
            ...thread.nudging,
            delegation: replacement.delegation,
          },
          updatedAt: command.createdAt,
        },
      };
      const queued: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: metaUpdated.eventId,
        type: "thread.queued-turn-created",
        payload: {
          threadId: command.threadId,
          queuedTurn: {
            id: command.queuedTurnId,
            threadId: command.threadId,
            message: command.message,
            ...(command.modelSelection ? { modelSelection: command.modelSelection } : {}),
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
            queuePosition: nextQueuePosition(thread.queuedTurns ?? []),
            failedAt: null,
            failureMessage: null,
          },
        },
      };
      const retiredAnswer =
        replacement.retiredPendingResponseQueuedTurnId === null
          ? []
          : [
              {
                ...withEventBase({
                  aggregateKind: "thread" as const,
                  aggregateId: command.threadId,
                  occurredAt: command.createdAt,
                  commandId: command.commandId,
                }),
                type: "thread.queued-turn-deleted" as const,
                payload: {
                  threadId: command.threadId,
                  queuedTurnId: replacement.retiredPendingResponseQueuedTurnId,
                  deletedAt: command.createdAt,
                },
              },
            ];
      return [...retiredAnswer, metaUpdated, queued];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          ...(command.replaceExisting === true ? { replaceExisting: true } : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.review-result.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.review-result-set",
        payload: {
          threadId: command.threadId,
          result: command.result,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const turnDiffCompletedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          agentTouchedPaths: command.agentTouchedPaths,
          turnFiles: command.turnFiles,
          transitionFiles: command.transitionFiles,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
      return turnDiffCompletedEvent;
    }

    case "thread.delegation.settle": {
      const child = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const childrenByParent = indexDelegationChildren(readModel.threads);
      const settlement = settleDelegation(readModel, child, command.settledAt, childrenByParent);
      if (!settlement) return [];
      return appendDelegationSettlement({
        readModel,
        child,
        settlement,
        commandId: command.commandId,
      });
    }

    case "thread.delegation.stall": {
      const child = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const childrenByParent = indexDelegationChildren(readModel.threads);
      const episode = delegationStallEpisode(readModel, child, command.createdAt, childrenByParent);
      if (!episode || episode.id !== command.stallId || episode.summary !== command.summary) {
        return [];
      }
      const delegation = child.nudging?.delegation;
      const parent = child.parentThreadId
        ? readModel.threads.find(
            (thread) => thread.id === child.parentThreadId && thread.deletedAt === null,
          )
        : undefined;
      if (!delegation || !parent) return [];
      const report: ChildNudgeUpdate = {
        id: episode.id,
        assignmentId: delegation.assignmentId,
        ...(delegation.dispatchId ? { dispatchId: delegation.dispatchId } : {}),
        childThreadId: child.id,
        childTitle: child.title,
        kind: "blocked",
        wakeReason: "assignment-blocked",
        summary: command.summary,
      };
      const notification: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.child-lifecycle-notified",
        payload: {
          parentThreadId: parent.id,
          childThreadId: child.id,
          childTitle: child.title,
          lifecycle: "blocked",
          dedupeKey: childLifecycleDedupeKey(child.id, "blocked", report.id),
          createdAt: command.createdAt,
          report,
        },
      };
      return [notification, queueChildNudge(parent, report, notification)];
    }

    case "thread.child.assignment.unavailable": {
      const parent = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (parent.archivedAt !== null || parent.deletedAt !== null) return [];
      const wait = parent.nudging?.wait;
      const assignment = wait?.assignments.find(
        (entry) =>
          entry.childThreadId === command.childThreadId &&
          entry.assignmentId === command.assignmentId,
      );
      if (!wait || wait.satisfiedAt || !assignment || assignment.outcome) return [];

      const child = readModel.threads.find((entry) => entry.id === command.childThreadId);
      const unavailable =
        !child ||
        child.archivedAt !== null ||
        child.deletedAt !== null ||
        child.parentThreadId !== parent.id ||
        child.nudging?.delegation?.assignmentId !== command.assignmentId;
      if (!unavailable) return [];

      const report: ChildNudgeUpdate = {
        id: `assignment-stale:${command.childThreadId}:${command.assignmentId}`,
        childThreadId: command.childThreadId,
        childTitle: child?.title ?? `Unavailable child ${command.childThreadId}`,
        assignmentId: command.assignmentId,
        kind: "blocked",
        summary:
          "A child assignment in this wait is no longer available because the child was detached, archived, deleted, or reassigned. Revise the wait condition before continuing.",
        wakeReason: "assignment-blocked",
      };
      const createdAt = nowIso();
      const notification: ChildLifecycleNotificationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: parent.id,
          occurredAt: createdAt,
          commandId: command.commandId,
        }),
        type: "thread.child-lifecycle-notified",
        payload: {
          parentThreadId: parent.id,
          childThreadId: command.childThreadId,
          childTitle: report.childTitle,
          lifecycle: "blocked",
          dedupeKey: childLifecycleDedupeKey(command.childThreadId, "blocked", report.id),
          createdAt,
          report,
        },
      };
      return [
        notification,
        nudgingMetaEvent(parent, notification, {
          ...parent.nudging,
          wait: {
            ...wait,
            assignments: wait.assignments.map((entry) =>
              entry.childThreadId === command.childThreadId &&
              entry.assignmentId === command.assignmentId
                ? { ...entry, outcome: "blocked" }
                : entry,
            ),
          },
        }),
        queueChildNudge(parent, report, notification),
      ];
    }

    case "thread.child.report": {
      const child = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const delegation = child.nudging?.delegation;
      if (!child.parentThreadId || !delegation || child.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Reporting requires an active delegated assignment.",
        });
      }
      const parent = yield* requireThread({ readModel, command, threadId: child.parentThreadId });
      if (
        recordedReportOutcome === undefined &&
        ((command.assignmentId !== undefined && command.assignmentId !== delegation.assignmentId) ||
          (delegation.assignedAt !== undefined && command.assignmentId === undefined))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Report assignment does not match the active assignment.",
        });
      }
      if (parent.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The parent thread has been deleted.",
        });
      }
      const reportIdentity = childReportIdentity({
        childThreadId: child.id,
        delegation,
        claimedAssignmentId: command.assignmentId,
        claimedDispatchId: command.dispatchId,
        originTurnId: command.originTurnId,
        reportId: command.reportId,
      });
      if (reportIdentity === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Reporting requires an active delegated assignment.",
        });
      }
      const { assignmentId: reportAssignmentId, dispatchId: reportDispatchId } = reportIdentity;
      const expectedDecisionId = reportIdentity.reportKey;
      const verdict = classifyChildReport({
        delegation,
        claimedDispatchId: command.dispatchId,
        claimedTurnId: command.originTurnId,
        kind: command.kind,
        recordedOutcome: recordedReportOutcome,
      });
      const verdictActivity = (summary: string): PlannedOrchestrationEvent => ({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: child.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: child.id,
          activity: {
            id: EventId.make(command.commandId),
            kind: "delegation.reported",
            tone: "info",
            summary,
            payload: {
              reportId: command.reportId,
              assignmentId: reportAssignmentId,
              ...(command.dispatchId ? { dispatchId: command.dispatchId } : {}),
              ...(command.originTurnId ? { originTurnId: command.originTurnId } : {}),
              dispatchVerdict: verdict,
            },
            // Attribute the audit record to the reporting execution's turn,
            // not the child's current session turn, so a late report from a
            // superseded turn is not misattributed to the active execution.
            turnId: command.originTurnId ?? child.session?.activeTurnId ?? null,
            createdAt: command.createdAt,
          },
        },
      });
      if (recordedReportOutcome !== undefined) {
        return verdictActivity(
          `Recorded ${recordedReportOutcome} outcome replayed for report '${command.reportId}' without applying it again.`,
        );
      }
      if (verdict !== "accepted") {
        return verdictActivity(
          verdict === "already-recorded"
            ? `Duplicate report '${command.reportId}' acknowledged without a second wake: the assignment already completed.`
            : `Stale report '${command.reportId}' recorded without waking the parent: it comes from a superseded execution or closed work.`,
        );
      }
      // Decision-conflict validation applies only to fenced-accepted reports:
      // a stale execution must receive a `stale` verdict and audit activity,
      // never a decision-conflict rejection that hides the fence outcome.
      // Supersede references may predate execution generations; accept the
      // legacy rendering alongside the canonical id.
      const supersedesCurrentDecision =
        command.supersedesReportId !== undefined &&
        delegation.decision &&
        (command.supersedesReportId === delegation.decision.id ||
          command.supersedesReportId ===
            legacyUpdateId({
              id: delegation.decision.id,
              childThreadId: child.id,
              dispatchId: delegation.decision.dispatchId,
              assignmentId: delegation.decision.assignmentId,
            }));
      if (
        (command.decision !== undefined && command.kind !== "decision-needed") ||
        (command.assignmentId !== undefined &&
          command.kind === "decision-needed" &&
          !command.decision) ||
        (command.kind === "decision-needed" &&
          delegation.decision &&
          !supersedesCurrentDecision &&
          delegation.decision.id !== expectedDecisionId) ||
        (command.supersedesReportId !== undefined &&
          (command.kind !== "decision-needed" || !supersedesCurrentDecision))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "A decision requires a question; resolve or explicitly supersede the current decision.",
        });
      }
      const source = verdictActivity(command.summary);
      const report = {
        id: expectedDecisionId,
        assignmentId: reportAssignmentId,
        ...(reportDispatchId ? { dispatchId: reportDispatchId } : {}),
        childThreadId: child.id,
        childTitle: child.title,
        kind: command.kind,
        wakeReason: childWakeReason({ kind: command.kind }),
        summary: command.summary,
        ...(command.decision !== undefined ? { decision: command.decision } : {}),
        ...(command.canContinue !== undefined ? { canContinue: command.canContinue } : {}),
        ...(command.supersedesReportId !== undefined
          ? { supersedesReportId: command.supersedesReportId }
          : {}),
      };
      return appendChildLifecycleNotification({
        readModel,
        childThread: child,
        sourceEvents: [source],
        sourceEvent: source,
        lifecycle: "reported",
        sourceKey: report.id,
        createdAt: command.createdAt,
        report,
        ...(command.originTurnId !== undefined ? { originTurnId: command.originTurnId } : {}),
      });
    }
    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      const sourceEvents: PlannedOrchestrationEvent[] = [activityEvent];
      if (
        SETTLEMENT_WAKING_ACTIVITY_KINDS.has(command.activity.kind) &&
        threadHasSettlementOverride(thread)
      ) {
        sourceEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }

      const lifecycle =
        command.activity.kind === "approval.requested"
          ? "approval-required"
          : command.activity.kind === "user-input.requested"
            ? "input-required"
            : command.activity.kind === "provider.turn.start.failed" ||
                command.activity.kind === "runtime.error"
              ? "failed"
              : null;
      if (lifecycle === null) {
        return sourceEvents;
      }
      const sourceKey =
        lifecycle === "approval-required" || lifecycle === "input-required"
          ? (requestId ?? command.activity.id)
          : (command.activity.turnId ?? thread.latestTurn?.turnId ?? command.activity.id);
      const originTurnId = command.activity.turnId ?? undefined;
      const delegation = thread.nudging?.delegation;
      // Route a delegated child's pending request to its parent. Unproven
      // provenance keeps the plain lifecycle history instead of being fenced away.
      const requestReport =
        (lifecycle === "approval-required" || lifecycle === "input-required") &&
        requestId !== undefined &&
        delegation?.completedAt === null &&
        ["authorized", "unfenced"].includes(
          classifyExecutionProvenance({ delegation, claimedTurnId: originTurnId }),
        )
          ? childPendingRequestUpdate({
              child: thread,
              delegation,
              lifecycle,
              requestId,
              payload: command.activity.payload,
            })
          : undefined;
      return appendChildLifecycleNotification({
        readModel,
        childThread: thread,
        sourceEvents,
        sourceEvent: activityEvent,
        lifecycle,
        sourceKey,
        createdAt: command.createdAt,
        ...(originTurnId !== undefined ? { originTurnId } : {}),
        ...(requestReport ? { report: requestReport } : {}),
      });
    }

    case "workflow.run.request": {
      const parentThread = yield* requireWritableProjectForThread({
        readModel,
        command,
        threadId: command.parentThreadId,
      });
      if (parentThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Parent thread '${command.parentThreadId}' is deleted.`,
        });
      }
      if (command.definition.nodes.length !== 1) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The durable workflow coordinator currently supports exactly one worker node.",
        });
      }
      if ((readModel.workflowRuns ?? []).some((run) => run.id === command.runId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow run '${command.runId}' already exists.`,
        });
      }
      const node = command.definition.nodes[0];
      if (!node) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The durable workflow coordinator requires one worker node.",
        });
      }
      const inputContext =
        command.inputArtifact.payload.kind === "input-context"
          ? command.inputArtifact.payload
          : undefined;
      if (
        command.inputArtifact.runId !== command.runId ||
        command.inputArtifact.nodeId !== node.id ||
        inputContext === undefined ||
        command.inputArtifact.producerThreadId !== command.parentThreadId ||
        inputContext.parentThreadId !== command.parentThreadId ||
        inputContext.contextPolicy !== node.contextPolicy ||
        (inputContext.contextPolicy === "none" &&
          (inputContext.messages.length > 0 || inputContext.summary !== undefined)) ||
        (inputContext.contextPolicy === "summary" && inputContext.messages.length > 0) ||
        (inputContext.contextPolicy === "selected-messages" && inputContext.summary !== undefined)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Workflow input artifact must be a parent-produced, policy-scoped artifact for the requested run and node.",
        });
      }
      const run = {
        id: command.runId,
        workflowId: command.definition.id,
        parentThreadId: command.parentThreadId,
        status: "pending" as const,
        nodes: [{ nodeId: node.id, status: "pending" as const }],
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const runRequested = {
        ...withEventBase({
          aggregateKind: "workflow",
          aggregateId: command.runId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "workflow.run-requested" as const,
        payload: {
          run,
          definition: command.definition,
          workerConfig: command.workerConfig,
        },
      };
      return [
        runRequested,
        {
          ...withEventBase({
            aggregateKind: "workflow",
            aggregateId: command.runId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          causationEventId: runRequested.eventId,
          type: "workflow.artifact-created" as const,
          payload: {
            artifact: command.inputArtifact,
          },
        },
      ];
    }

    case "workflow.node.worker.start": {
      const run = (readModel.workflowRuns ?? []).find((entry) => entry.id === command.runId);
      const node = run?.nodes.find((entry) => entry.nodeId === command.nodeId);
      if (!run || !node || node.status !== "pending") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow node '${command.nodeId}' is not pending in run '${command.runId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "workflow",
          aggregateId: command.runId,
          occurredAt: command.startedAt,
          commandId: command.commandId,
        }),
        type: "workflow.node-worker-started",
        payload: {
          runId: command.runId,
          nodeId: command.nodeId,
          workerThreadId: command.workerThreadId,
          startedAt: command.startedAt,
        },
      };
    }

    case "workflow.worker-result.record": {
      const run = (readModel.workflowRuns ?? []).find((entry) => entry.id === command.runId);
      const nodeId = command.artifact.nodeId;
      const node =
        nodeId === undefined ? undefined : run?.nodes.find((entry) => entry.nodeId === nodeId);
      if (
        !run ||
        !node ||
        node.status !== "running" ||
        command.artifact.runId !== command.runId ||
        command.artifact.payload.kind !== "worker-result" ||
        command.artifact.producerThreadId !== node.workerThreadId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Worker result does not match the running node in workflow run '${command.runId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "workflow",
          aggregateId: command.runId,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        }),
        type: "workflow.worker-result-recorded",
        payload: {
          runId: command.runId,
          artifact: command.artifact,
          completedAt: command.completedAt,
        },
      };
    }

    case "workflow.run.finalize": {
      const run = (readModel.workflowRuns ?? []).find((entry) => entry.id === command.runId);
      const node = run?.nodes[0];
      if (
        !run ||
        run.parentThreadId !== command.parentThreadId ||
        !node ||
        (node.status !== "completed" && node.status !== "failed" && node.status !== "pending") ||
        (node.status === "pending" && command.status !== "failed") ||
        (node.status !== "pending" && command.status !== node.status) ||
        command.artifact.runId !== command.runId ||
        command.artifact.payload.kind !== "final-result"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workflow run '${command.runId}' is not ready to finalize.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "workflow",
          aggregateId: command.runId,
          occurredAt: command.completedAt,
          commandId: command.commandId,
        }),
        type: "workflow.run-finalized",
        payload: {
          runId: command.runId,
          parentThreadId: command.parentThreadId,
          artifact: command.artifact,
          status: command.status,
          completedAt: command.completedAt,
        },
      };
    }

    default: {
      const unexpectedCommand: never = command;
      const commandType = String(unexpectedCommand);
      return yield* new OrchestrationCommandInvariantError({
        commandType,
        detail: `Unknown command type: ${commandType}`,
      });
    }
  }
});
