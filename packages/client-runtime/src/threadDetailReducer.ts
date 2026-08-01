import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as O from "effect/Order";
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

/**
 * Retention limits for collections within a thread.
 * These prevent unbounded growth of in-memory thread state.
 */
export interface ThreadDetailRetentionLimits {
  readonly maxMessages: number;
  readonly maxProposedPlans: number;
  readonly maxCheckpoints: number;
  readonly maxActivities: number;
}

export const DEFAULT_THREAD_DETAIL_LIMITS: ThreadDetailRetentionLimits = {
  maxMessages: 512,
  maxProposedPlans: 64,
  maxCheckpoints: 256,
  maxActivities: 128,
};

export type ThreadDetailReducerResult =
  | { readonly kind: "updated"; readonly thread: OrchestrationThread }
  | { readonly kind: "deleted" }
  | { readonly kind: "unchanged" };

const proposedPlanOrder = O.combine<OrchestrationThread["proposedPlans"][number]>(
  O.mapInput(O.String, (p) => p.createdAt),
  O.mapInput(O.String, (p) => p.id),
);

const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread["checkpoints"][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

const MAX_ACTIVITY_CONTEXT_PLANS = 64;

function activityLifecycleRank(activity: OrchestrationThreadActivity): number {
  return activity.kind.endsWith(".completed") ||
    activity.kind.endsWith(".resolved") ||
    activity.kind.endsWith(".failed")
    ? 2
    : 1;
}

const activityOrder = O.combineAll<OrchestrationThreadActivity>([
  O.mapInput(O.String, (activity) => activity.createdAt),
  O.mapInput(O.Number, activityLifecycleRank),
  O.mapInput(O.String, (activity) => activity.id),
]);

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  return activityOrder(left, right);
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function activityContextKey(activity: OrchestrationThreadActivity): string | null {
  const payload = activityPayload(activity);
  if (
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "provider.approval.respond.failed" ||
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved" ||
    activity.kind === "provider.user-input.respond.failed"
  ) {
    return typeof payload?.requestId === "string" ? `request:${payload.requestId}` : null;
  }
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return typeof payload?.taskId === "string" ? `task:${payload.taskId}` : null;
  }
  return null;
}

function isActivityContextStart(activity: OrchestrationThreadActivity): boolean {
  const payload = activityPayload(activity);
  return (
    activity.kind === "approval.requested" ||
    activity.kind === "user-input.requested" ||
    (activity.kind === "task.started" && payload?.taskType === "background-agent")
  );
}

function isActivityContextTerminal(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind === "provider.approval.respond.failed" ||
    activity.kind === "provider.user-input.respond.failed"
  ) {
    const detail = activityPayload(activity)?.detail;
    if (typeof detail !== "string") {
      return false;
    }
    const normalized = detail.toLowerCase();
    return (
      normalized.includes("stale pending approval request") ||
      normalized.includes("stale pending user-input request") ||
      normalized.includes("unknown pending approval request") ||
      normalized.includes("unknown pending permission request") ||
      normalized.includes("unknown pending user-input request")
    );
  }
  return (
    activity.kind === "approval.resolved" ||
    activity.kind === "user-input.resolved" ||
    activity.kind === "task.completed"
  );
}

function reconcileActivityContext(
  context: readonly OrchestrationThreadActivity[] | undefined,
  activity: OrchestrationThreadActivity,
): readonly OrchestrationThreadActivity[] {
  const current = context ?? [];
  if (activity.kind === "turn.plan.updated") {
    const nonPlans = current.filter((entry) => entry.kind !== "turn.plan.updated");
    const plans = current
      .filter((entry) => entry.kind === "turn.plan.updated" && entry.id !== activity.id)
      .concat(activity)
      .toSorted(compareActivities)
      .slice(-MAX_ACTIVITY_CONTEXT_PLANS);
    return [...nonPlans, ...plans].toSorted(compareActivities);
  }

  const key = activityContextKey(activity);
  if (!key || (!isActivityContextStart(activity) && !isActivityContextTerminal(activity))) {
    return current;
  }

  const next = current.filter((entry) => activityContextKey(entry) !== key);
  if (isActivityContextStart(activity)) {
    next.push(activity);
  }
  return next.toSorted(compareActivities);
}

/**
 * Apply a single orchestration event to an `OrchestrationThread`, returning
 * the updated thread, a deletion signal, or an "unchanged" marker when the
 * event doesn't affect this thread.
 *
 * This is a pure reducer operating on contract types. UI-specific mapping
 * (e.g. resolving attachment preview URLs, normalising model slugs, adding
 * scoped fields like `environmentId`) is the caller's responsibility.
 */
export function applyThreadDetailEvent(
  thread: OrchestrationThread,
  event: OrchestrationEvent,
  limits: ThreadDetailRetentionLimits = DEFAULT_THREAD_DETAIL_LIMITS,
): ThreadDetailReducerResult {
  switch (event.type) {
    // ── Project events (irrelevant to thread detail) ────────────────
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
      return { kind: "unchanged" };

    // ── Thread lifecycle ────────────────────────────────────────────
    case "thread.created":
      return {
        kind: "updated",
        thread: {
          id: event.payload.threadId,
          projectId: event.payload.projectId,
          parentThreadId: event.payload.parentThreadId ?? null,
          title: event.payload.title,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          pendingRuntimeMode: event.payload.pendingRuntimeMode ?? null,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          latestTurn: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      };

    case "thread.deleted":
      return { kind: "deleted" };

    case "thread.archived":
      return {
        kind: "updated",
        thread: {
          ...thread,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unarchived":
      return {
        kind: "updated",
        thread: { ...thread, archivedAt: null, updatedAt: event.payload.updatedAt },
      };

    case "thread.settled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: "settled",
          settledAt: event.payload.settledAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsettled":
      return {
        kind: "updated",
        thread: {
          ...thread,
          settledOverride: event.payload.reason === "user" ? "active" : null,
          settledAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.snoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: event.payload.snoozedUntil,
          snoozedAt: event.payload.snoozedAt,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.unsnoozed":
      return {
        kind: "updated",
        thread: {
          ...thread,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.decoupled":
      return {
        kind: "updated",
        thread: { ...thread, parentThreadId: null, updatedAt: event.payload.updatedAt },
      };

    // ── Thread metadata ─────────────────────────────────────────────
    case "thread.meta-updated":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.runtime-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    case "thread.interaction-mode-set":
      return {
        kind: "updated",
        thread: {
          ...thread,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        },
      };

    // ── Turn lifecycle ──────────────────────────────────────────────
    case "thread.turn-start-requested":
      return {
        kind: "updated",
        thread: {
          ...thread,
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.occurredAt,
        },
      };

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return { kind: "unchanged" };
      }
      const latestTurn = thread.latestTurn;
      if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
        return { kind: "unchanged" };
      }
      return {
        kind: "updated",
        thread: {
          ...thread,
          latestTurn: {
            ...latestTurn,
            state: "interrupted",
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
          },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Messages ────────────────────────────────────────────────────
    case "thread.message-sent": {
      const message: OrchestrationMessage = {
        id: event.payload.messageId,
        role: event.payload.role,
        text: event.payload.text,
        ...(event.payload.attachments !== undefined
          ? { attachments: event.payload.attachments }
          : {}),
        turnId: event.payload.turnId,
        streaming: event.payload.streaming,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      };

      const lastMessage = thread.messages.at(-1);
      const messageIndex =
        lastMessage?.id === message.id
          ? thread.messages.length - 1
          : thread.messages.findIndex((entry) => entry.id === message.id);
      const messages =
        messageIndex === -1
          ? Arr.append(thread.messages, message)
          : [
              ...thread.messages.slice(0, messageIndex),
              {
                ...thread.messages[messageIndex]!,
                text: message.streaming
                  ? `${thread.messages[messageIndex]!.text}${message.text}`
                  : message.text.length > 0
                    ? message.text
                    : thread.messages[messageIndex]!.text,
                streaming: message.streaming,
                ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
                ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
              },
              ...thread.messages.slice(messageIndex + 1),
            ];
      const cappedMessages = Arr.takeRight(messages, limits.maxMessages);

      // Update latestTurn for assistant messages bound to a turn.
      const latestTurn: OrchestrationThread["latestTurn"] =
        event.payload.role === "assistant" &&
        event.payload.turnId !== null &&
        (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
          ? {
              turnId: event.payload.turnId,
              state: event.payload.streaming
                ? "running"
                : thread.latestTurn?.state === "interrupted"
                  ? "interrupted"
                  : thread.latestTurn?.state === "error"
                    ? "error"
                    : "completed",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.createdAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                  : event.payload.createdAt,
              completedAt: event.payload.streaming
                ? thread.latestTurn?.turnId === event.payload.turnId
                  ? (thread.latestTurn.completedAt ?? null)
                  : null
                : event.payload.updatedAt,
              assistantMessageId: event.payload.messageId,
            }
          : thread.latestTurn;

      // Rebind checkpoint assistant message IDs for assistant messages.
      const checkpoints =
        event.payload.role === "assistant" && event.payload.turnId !== null
          ? rebindCheckpointAssistantMessage(
              thread.checkpoints,
              event.payload.turnId,
              event.payload.messageId,
            )
          : thread.checkpoints;

      return {
        kind: "updated",
        thread: {
          ...thread,
          messages: cappedMessages,
          checkpoints,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Session ─────────────────────────────────────────────────────
    case "thread.session-set": {
      const latestTurn: OrchestrationLatestTurn | null =
        event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
          ? {
              turnId: event.payload.session.activeTurnId,
              state: "running",
              requestedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.requestedAt
                  : event.payload.session.updatedAt,
              startedAt:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                  : event.payload.session.updatedAt,
              completedAt: null,
              assistantMessageId:
                thread.latestTurn?.turnId === event.payload.session.activeTurnId
                  ? thread.latestTurn.assistantMessageId
                  : null,
            }
          : thread.latestTurn;

      return {
        kind: "updated",
        thread: {
          ...thread,
          session: event.payload.session,
          latestTurn,
          updatedAt: event.occurredAt,
        },
      };
    }

    case "thread.session-stop-requested":
      return thread.session === null
        ? { kind: "unchanged" }
        : {
            kind: "updated",
            thread: {
              ...thread,
              session: {
                ...thread.session,
                status: "stopped",
                activeTurnId: null,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
          };

    // ── Proposed plans ──────────────────────────────────────────────
    case "thread.proposed-plan-upserted": {
      const proposedPlan = event.payload.proposedPlan;

      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((entry) => entry.id !== proposedPlan.id),
        Arr.append(proposedPlan),
        Arr.sort(proposedPlanOrder),
        Arr.takeRight(limits.maxProposedPlans),
      );

      return {
        kind: "updated",
        thread: { ...thread, proposedPlans, updatedAt: event.occurredAt },
      };
    }

    // ── Checkpoints / turn diffs ────────────────────────────────────
    case "thread.turn-diff-completed": {
      const checkpoint: OrchestrationCheckpointSummary = {
        turnId: event.payload.turnId,
        checkpointTurnCount: event.payload.checkpointTurnCount,
        checkpointRef: event.payload.checkpointRef,
        status: event.payload.status,
        files: event.payload.files,
        agentTouchedPaths: event.payload.agentTouchedPaths ?? [],
        turnFiles: event.payload.turnFiles ?? [],
        assistantMessageId: event.payload.assistantMessageId,
        completedAt: event.payload.completedAt,
      };

      const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
      // Don't overwrite a non-missing checkpoint with a missing one.
      if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
        return { kind: "unchanged" };
      }

      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
        Arr.append(checkpoint),
        Arr.sort(checkpointOrder),
        Arr.takeRight(limits.maxCheckpoints),
      );

      const latestTurn =
        thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
          ? {
              turnId: event.payload.turnId,
              state: checkpointStatusToTurnState(event.payload.status),
              requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
              startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
              assistantMessageId: event.payload.assistantMessageId,
            }
          : thread.latestTurn;

      return {
        kind: "updated",
        thread: { ...thread, checkpoints, latestTurn, updatedAt: event.occurredAt },
      };
    }

    // ── Revert ──────────────────────────────────────────────────────
    case "thread.reverted": {
      const checkpoints = pipe(
        thread.checkpoints,
        Arr.filter(
          (entry) =>
            entry.checkpointTurnCount !== undefined &&
            entry.checkpointTurnCount <= event.payload.turnCount,
        ),
        Arr.sort(checkpointOrder),
        Arr.takeRight(limits.maxCheckpoints),
      );

      const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
      const messages = pipe(
        retainMessagesAfterRevert(thread.messages, retainedTurnIds),
        Arr.takeRight(limits.maxMessages),
      );
      const proposedPlans = pipe(
        thread.proposedPlans,
        Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
        Arr.takeRight(limits.maxProposedPlans),
      );
      const activities = pipe(
        thread.activities,
        Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
      );
      const activityContext = thread.activityContext?.filter(
        (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
      );
      const latestCheckpoint = checkpoints.at(-1) ?? null;

      return {
        kind: "updated",
        thread: {
          ...thread,
          checkpoints,
          messages,
          proposedPlans,
          activities,
          ...(activityContext ? { activityContext } : {}),
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToTurnState(
                    latestCheckpoint.status as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        },
      };
    }

    // ── Activities ──────────────────────────────────────────────────
    case "thread.activity-appended": {
      const activity = event.payload.activity;
      const activities = pipe(
        thread.activities,
        Arr.filter((entry) => entry.id !== activity.id),
        Arr.append(activity),
        Arr.sort(activityOrder),
        Arr.takeRight(limits.maxActivities),
      );
      const activityContext = reconcileActivityContext(thread.activityContext, activity);

      return {
        kind: "updated",
        thread: { ...thread, activities, activityContext, updatedAt: event.occurredAt },
      };
    }

    // ── Events that don't mutate thread state directly ──────────────
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.checkpoint-revert-requested":
      return { kind: "unchanged" };
  }

  // Forward-compatible: ignore unrecognized event types.
  return { kind: "unchanged" };
}

// ── Helpers ──────────────────────────────────────────────────────────

function checkpointStatusToTurnState(
  status: "ready" | "missing" | "speculative" | "error",
): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "missing":
      return "interrupted";
    case "speculative":
      return "running";
  }
}

function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): OrchestrationCheckpointSummary[] {
  return Arr.map(checkpoints, (entry) =>
    entry.turnId === turnId ? { ...entry, assistantMessageId: messageId } : entry,
  );
}

function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationMessage[] {
  // Keep messages that belong to a retained turn, plus system messages and
  // messages without a turn binding (pre-turn-0 user messages).
  return Arr.filter(messages, (message) => {
    if (message.role === "system") {
      return true;
    }
    if (message.turnId === null) {
      return true;
    }
    return retainedTurnIds.has(message.turnId);
  });
}
