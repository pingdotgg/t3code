import { deriveThreadBusyState } from "@t3tools/shared/threadBusyState";
import type {
  OrchestrationCommand,
  OrchestrationMessage,
  OrchestrationQueuedTurn,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
export { nextQueuePosition } from "@t3tools/shared/queuedTurnOrder";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

/**
 * Detail for the invariant that blocks turn starts and unrelated queued-turn
 * dispatches while a child decision is pending. Only the correlated decision
 * response (pendingResponse) may dispatch. Shared with QueuedTurnReactor so a
 * reword here cannot silently revert the reactor to failing queued turns.
 */
export const CHILD_DECISION_BLOCKED_DETAIL =
  "Resolve the current child decision through its correlated response before continuing.";

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireWritableProjectForThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) => {
      const project = findProjectById(input.readModel, thread.projectId);
      return project?.kind === "chat-import"
        ? Effect.fail(
            invariantError(
              input.command.type,
              `Imported chat '${input.threadId}' is reference-only and cannot start agent work.`,
            ),
          )
        : Effect.succeed(thread);
    }),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

/**
 * Busy means "a turn start is accepted or running", per the shared
 * `deriveThreadBusyState` so this cannot drift from what clients offer.
 *
 * This previously also compared the newest user message against the newest
 * completed turn. That timestamp stood in for the acceptance-to-acknowledgement
 * window and was wrong in both directions: a manual stop can share a message's
 * millisecond with its terminal turn, while a forked thread or a
 * checkpoint-less turn leaves no completed turn to compare against. The second
 * case wedged the thread permanently, rejecting every later start while the UI
 * showed it idle. See `packages/shared/src/threadBusyState.ts`.
 */
export function threadHasInFlightTurn(thread: OrchestrationThread): boolean {
  return deriveThreadBusyState(thread) !== "idle";
}

/**
 * Whether a checkout may be rewritten under this thread — auto-pull, checkout
 * restore, and similar Git mutations.
 *
 * This is deliberately *broader* than {@link threadHasInFlightTurn}. A thread
 * whose newest user message postdates its newest completed turn has unanswered
 * work whose turn never started, so pulling the branch under it would move the
 * ground out from under that work even though the thread is not busy enough to
 * block a new turn start. That question is about file-system safety, not about
 * turn admission, which is why the timestamp comparison lives here instead of
 * in the invariant.
 */
export function threadCheckoutHasUnsettledWork(thread: OrchestrationThread): boolean {
  if (threadHasInFlightTurn(thread)) {
    return true;
  }
  const latestUserMessage = thread.messages.findLast((message) => message.role === "user");
  if (!latestUserMessage) {
    return false;
  }
  // A thread with no completed turn at all has unresolved work whenever a user
  // message is waiting on it. The old code excluded this by also accepting a
  // matching `provider.turn.start.failed`, but that made a failed start with no
  // completed turn block checkout rewrites forever; a thread that never got a
  // turn is exactly the case where an unanswered message is the signal.
  if (thread.latestTurn?.completedAt == null) {
    return true;
  }
  return latestUserMessage.createdAt > thread.latestTurn.completedAt;
}

// Shared by the probes below: they ask different questions but must agree on
// which messages count as "the provider never got a turn". Takes the message the
// caller already resolved rather than re-scanning `thread.messages`.
function hasFailedTurnStart(
  thread: OrchestrationThread,
  latestUserMessage: OrchestrationMessage | undefined,
): boolean {
  if (!latestUserMessage) {
    return false;
  }
  return thread.activities.some((activity) => {
    if (
      activity.kind !== "provider.turn.start.failed" ||
      activity.createdAt < latestUserMessage.createdAt
    ) {
      return false;
    }
    const messageId =
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      "messageId" in activity.payload &&
      typeof activity.payload.messageId === "string"
        ? activity.payload.messageId
        : null;
    return messageId === null || messageId === latestUserMessage.id;
  });
}

export function threadHasQueuedTurnStart(
  thread: OrchestrationThread,
  options: { readonly now: string },
): boolean {
  const latestUserMessage = thread.messages.findLast((message) => message.role === "user");
  if (!latestUserMessage) {
    return false;
  }
  const latestMessageAt = Date.parse(latestUserMessage.createdAt);
  const nowAt = Date.parse(options.now);
  if (
    !Number.isFinite(latestMessageAt) ||
    !Number.isFinite(nowAt) ||
    Math.abs(nowAt - latestMessageAt) > 2 * 60 * 1_000
  ) {
    return false;
  }
  if (hasFailedTurnStart(thread, latestUserMessage)) {
    return false;
  }
  return thread.latestTurn === null || thread.latestTurn.completedAt === null
    ? thread.latestTurn?.state !== "running"
    : latestUserMessage.createdAt >= thread.latestTurn.completedAt;
}

/**
 * `settledAt` is written exactly when `settledOverride` becomes "settled", so
 * the override alone decides whether real activity must reset the lifecycle:
 * a settled thread wakes, and a user-pinned "active" thread unpins.
 */
export function threadHasSettlementOverride(thread: OrchestrationThread): boolean {
  return (thread.settledOverride ?? null) !== null;
}

export function threadIsSnoozed(thread: OrchestrationThread): boolean {
  return (thread.snoozedUntil ?? null) !== null || (thread.snoozedAt ?? null) !== null;
}

function activityRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
}

function threadHasUnresolvedActivity(
  thread: OrchestrationThread,
  requestedKind: string,
  resolvedKind: string,
): boolean {
  const pending = new Set<string>();
  for (const activity of thread.activities
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const requestId = activityRequestId(activity.payload);
    if (requestId === null) continue;
    if (activity.kind === requestedKind) {
      pending.add(requestId);
    } else if (activity.kind === resolvedKind) {
      pending.delete(requestId);
    }
  }
  return pending.size > 0;
}

export function threadHasPendingInteraction(thread: OrchestrationThread): boolean {
  return (
    threadHasUnresolvedActivity(thread, "approval.requested", "approval.resolved") ||
    threadHasUnresolvedActivity(thread, "user-input.requested", "user-input.resolved")
  );
}

/**
 * A held queue is never ready: crash recovery holds it so no queued prompt
 * fires unprompted, and only an explicit release clears that. Every admission
 * path goes through this predicate so the hold cannot be bypassed.
 */
export function threadQueueIsHeld(thread: OrchestrationThread): boolean {
  return thread.queueHeldAt != null;
}

export function isThreadReadyForQueuedDispatch(thread: OrchestrationThread): boolean {
  return (
    !threadQueueIsHeld(thread) &&
    !threadHasInFlightTurn(thread) &&
    !threadHasPendingInteraction(thread)
  );
}

export function findQueuedTurnById(
  thread: OrchestrationThread,
  queuedTurnId: string,
): OrchestrationQueuedTurn | undefined {
  return (thread.queuedTurns ?? []).find((queuedTurn) => queuedTurn.id === queuedTurnId);
}

export function requireQueuedTurn(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
  readonly queuedTurnId: string;
}): Effect.Effect<
  { readonly thread: OrchestrationThread; readonly queuedTurn: OrchestrationQueuedTurn },
  OrchestrationCommandInvariantError
> {
  return requireThread({
    readModel: input.readModel,
    command: input.command,
    threadId: input.threadId,
  }).pipe(
    Effect.flatMap((thread) => {
      const queuedTurn = findQueuedTurnById(thread, input.queuedTurnId);
      return queuedTurn
        ? Effect.succeed({ thread, queuedTurn })
        : Effect.fail(
            invariantError(
              input.command.type,
              `Queued turn '${input.queuedTurnId}' does not exist on thread '${input.threadId}'.`,
            ),
          );
    }),
  );
}

export function requireThreadReadyForTurnStart(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      threadHasInFlightTurn(thread)
        ? Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' already has a turn in flight. Wait for it to finish or interrupt it before starting another turn.`,
            ),
          )
        : Effect.succeed(thread),
    ),
  );
}

export function resolveActiveTurnId(thread: OrchestrationThread): TurnId | undefined {
  return (
    thread.session?.activeTurnId ??
    (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : undefined)
  );
}

export function requireThreadWithInFlightTurn(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<
  { readonly thread: OrchestrationThread; readonly turnId: TurnId },
  OrchestrationCommandInvariantError
> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) => {
      const turnId = resolveActiveTurnId(thread);
      return turnId === undefined
        ? Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' has no active turn to steer yet. Queue the message or wait for the turn to start.`,
            ),
          )
        : Effect.succeed({ thread, turnId });
    }),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
