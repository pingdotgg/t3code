import {
  CommandId,
  MessageId,
  PullRequestMonitorFeedbackDeliveryId,
  QueuedTurnId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Cause, Duration, Effect, Layer, Option, PubSub, Result, Schema, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { automaticPrFeedbackBlockReason } from "@t3tools/shared/automaticPrFeedback";
import {
  feedbackStableKeyOf,
  reconcileFeedbackItem,
} from "../../pullRequestMonitor/feedbackReconciliation.ts";
import { PullRequestMonitorFeedbackService } from "../../pullRequestMonitor/PullRequestMonitorFeedbackService.ts";
import { computeReadiness } from "../../pullRequestMonitor/readiness.ts";
import { buildWakePrompt } from "../../pullRequestMonitor/wakePrompt.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { QueuedTurnReactor, type QueuedTurnReactorShape } from "../Services/QueuedTurnReactor.ts";
import {
  CHILD_DECISION_BLOCKED_DETAIL,
  isThreadReadyForQueuedDispatch,
} from "../commandInvariants.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { isAutomaticChildNudgeBlocked } from "../childNudging.ts";
import { childWaitIsSatisfied, evaluateChildFollowUp } from "@t3tools/shared/childFollowUp";
import {
  delegationSettlementNotBefore,
  delegationStallEpisode,
  settleDelegation,
} from "../delegationSettlement.ts";

const MONITOR_REVALIDATION_RETRY_INTERVAL = Duration.seconds(20);
const MAX_MONITOR_REVALIDATION_ATTEMPTS = 3;
const MONITOR_REVALIDATION_RETRY_BASE_MS = 20_000;

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

// A dispatch rejected by the decider's child-decision invariant (see
// CHILD_DECISION_BLOCKED_DETAIL in commandInvariants.ts) is a transient
// ordering conflict, not a permanent failure: the turn must wait until the
// decision is resolved. Match the typed invariant error rather than rendered
// text so message-format changes cannot silently revert to failing turns.
const isChildDecisionBlockedCause = (cause: Cause.Cause<unknown>): boolean => {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  return (
    isInvariantError(failure) &&
    failure.commandType === "thread.queued-turn.dispatch" &&
    failure.detail === CHILD_DECISION_BLOCKED_DETAIL
  );
};

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function threadIdForEvent(event: OrchestrationEvent): ThreadId | null {
  return event.aggregateKind === "thread" ? (event.aggregateId as ThreadId) : null;
}

function canChangeQueuedTurnReadiness(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
    case "thread.child-lifecycle-notified":
    case "thread.turn-diff-completed":
      return false;
    default:
      return event.aggregateKind === "thread";
  }
}

function canChangeDelegationSettlement(event: OrchestrationEvent): boolean {
  if (event.type === "thread.activity-appended") {
    switch (event.payload.activity.kind) {
      case "approval.requested":
      case "approval.resolved":
      case "insights.turn.completed":
      case "user-input.requested":
      case "user-input.resolved":
        return true;
      default:
        return false;
    }
  }
  switch (event.type) {
    case "thread.archived":
    case "thread.child-lifecycle-notified":
    case "thread.decoupled":
    case "thread.deleted":
    case "thread.message-sent":
    case "thread.meta-updated":
    case "thread.queued-turn-created":
    case "thread.queued-turn-deleted":
    case "thread.queued-turn-dispatched":
    case "thread.queued-turn-failed":
    case "thread.queued-turn-updated":
    case "thread.session-set":
    case "thread.turn-start-requested":
    case "thread.unarchived":
      return true;
    default:
      return false;
  }
}

function canInvalidateChildAssignment(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.meta-updated":
    case "thread.archived":
    case "thread.deleted":
    case "thread.decoupled":
      return true;
    default:
      return false;
  }
}

interface ThreadReadModelIndex {
  readonly readModel: OrchestrationReadModel;
  readonly threadsById: ReadonlyMap<ThreadId, OrchestrationThread>;
  readonly waitingParentsByChildId: ReadonlyMap<
    ThreadId,
    ReadonlyArray<{
      readonly parentThreadId: ThreadId;
      readonly assignmentId: MessageId;
    }>
  >;
}

function indexReadModel(readModel: OrchestrationReadModel): ThreadReadModelIndex {
  const threadsById = new Map<ThreadId, OrchestrationThread>();
  const waitingParentsByChildId = new Map<
    ThreadId,
    Array<{ readonly parentThreadId: ThreadId; readonly assignmentId: MessageId }>
  >();
  for (const thread of readModel.threads) {
    threadsById.set(thread.id, thread);
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    for (const assignment of thread.nudging?.wait?.assignments ?? []) {
      if (assignment.outcome !== undefined) continue;
      const waitingParents = waitingParentsByChildId.get(assignment.childThreadId);
      const waitingParent = {
        parentThreadId: thread.id,
        assignmentId: assignment.assignmentId,
      };
      if (waitingParents) {
        waitingParents.push(waitingParent);
      } else {
        waitingParentsByChildId.set(assignment.childThreadId, [waitingParent]);
      }
    }
  }
  return { readModel, threadsById, waitingParentsByChildId };
}

const makeQueuedTurnReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const pullRequests = yield* PullRequestService;
  const monitorFeedback = yield* PullRequestMonitorFeedbackService;
  const serverSettings = yield* ServerSettingsService;
  const wakeScope = yield* Effect.scope;
  const drainingThreadIds = new Set<ThreadId>();
  const pendingThreadIds = new Set<ThreadId>();
  const scheduledChildWakes = new Set<string>();

  const failQueuedTurn = (input: {
    readonly threadId: ThreadId;
    readonly queuedTurnId: QueuedTurnId;
    readonly detail: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.queued-turn.fail",
      commandId: serverCommandId("queued-turn.fail"),
      threadId: input.threadId,
      queuedTurnId: input.queuedTurnId,
      failureMessage: input.detail.length > 0 ? input.detail : "Failed to dispatch queued message.",
      failedAt: new Date().toISOString(),
    });

  const drainThread = Effect.fn("QueuedTurnReactor.drainThread")(function* (threadId: ThreadId) {
    if (drainingThreadIds.has(threadId)) {
      pendingThreadIds.add(threadId);
      return;
    }
    drainingThreadIds.add(threadId);
    try {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const wait = thread.nudging?.wait;
      if (
        wait?.deadlineAt &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        !wait.satisfiedAt &&
        !childWaitIsSatisfied(wait) &&
        wait.assignments.some((assignment) => assignment.outcome === undefined)
      ) {
        if (Date.parse(wait.deadlineAt) <= Date.now()) {
          yield* orchestrationEngine.dispatch({
            type: "thread.child-wait.deadline-expire",
            commandId: serverCommandId("child-wait.deadline-expire"),
            threadId,
            expectedDeadlineAt: wait.deadlineAt,
            ...(wait.generationId !== undefined ? { expectedGenerationId: wait.generationId } : {}),
            expiredAt: new Date().toISOString(),
          });
          return;
        }
        yield* scheduleChildWake(threadId, wait.deadlineAt, "wait-deadline", wait.generationId);
      }
      const queuedTurns = thread?.queuedTurns ?? [];
      if (queuedTurns.length === 0 || !isThreadReadyForQueuedDispatch(thread)) {
        return;
      }

      const threadsById = new Map(
        queuedTurns.some((turn) => turn.origin?.kind === "child-nudge")
          ? readModel.threads.map((entry) => [entry.id, entry] as const)
          : [],
      );
      const nowIso = new Date().toISOString();
      const eligibleTurns = [];
      for (const turn of queuedTurns) {
        if (turn.origin?.kind !== "child-nudge") {
          eligibleTurns.push(turn);
          continue;
        }
        if (turn.failedAt !== null) continue;
        const followUp = evaluateChildFollowUp(thread, turn, threadsById, nowIso);
        if (followUp.dueAt) {
          yield* scheduleChildWake(threadId, followUp.dueAt, "collection");
        }
        if (!followUp.reason) eligibleTurns.push(turn);
      }
      eligibleTurns.sort((left, right) => {
        const leftUser = left.origin === undefined ? 0 : 1;
        const rightUser = right.origin === undefined ? 0 : 1;
        return leftUser - rightUser || left.createdAt.localeCompare(right.createdAt);
      });
      let nextQueuedTurn = eligibleTurns[0];
      if (eligibleTurns.some((turn) => turn.origin?.kind === "pull-request-monitor")) {
        const settings = yield* serverSettings.getSettings;
        nextQueuedTurn = eligibleTurns.find(
          (turn) =>
            turn.failedAt !== null ||
            turn.origin?.kind !== "pull-request-monitor" ||
            automaticPrFeedbackBlockReason(
              settings,
              turn.modelSelection?.instanceId ?? thread.modelSelection.instanceId,
              thread.session,
            ) === null,
        );
      }
      if (!nextQueuedTurn || nextQueuedTurn.failedAt !== null) return;

      // While a child decision is pending, only its correlated decision
      // response may dispatch. Anything else stays queued (waiting) so the
      // user can resolve the decision first; failing it here would turn a
      // transient ordering conflict into a permanent Paused error. A queued
      // response still jumps ahead of unrelated waiting turns.
      // Note the decider clears `decision` atomically when it creates
      // `pendingResponse`, so gate the fast-path on the response itself: a
      // real answer exists as `decision: null` plus `pendingResponse` set.
      const activeDelegation =
        thread.nudging?.delegation?.completedAt === null ? thread.nudging.delegation : undefined;
      const pendingResponseId = activeDelegation?.pendingResponse?.queuedTurnId ?? null;
      if (pendingResponseId !== null) {
        const responseTurn = eligibleTurns.find(
          (turn) => turn.id === pendingResponseId && turn.failedAt === null,
        );
        if (!responseTurn) return;
        nextQueuedTurn = responseTurn;
      } else if (activeDelegation?.decision) {
        return;
      }

      const blockedByCollaborationWait = (thread.collaborationRequests ?? []).some(
        (request) =>
          request.senderThreadId === thread.id && request.blocking && request.status === "waiting",
      );
      if (
        blockedByCollaborationWait &&
        nextQueuedTurn.origin?.kind !== "collaboration-response" &&
        nextQueuedTurn.origin !== undefined
      ) {
        return;
      }

      const origin = nextQueuedTurn.origin;
      if (origin?.kind === "pull-request-monitor" && origin.headSha !== undefined) {
        const observedHeadSha = origin.headSha;
        const now = new Date();
        if (
          origin.nextRevalidationAt !== undefined &&
          origin.nextRevalidationAt > now.toISOString()
        ) {
          return;
        }
        const snapshotResult = yield* Effect.result(
          pullRequests.monitorSnapshot({
            projectId: thread.projectId,
            repository: origin.repository,
            number: origin.number,
          }),
        );
        if (Result.isFailure(snapshotResult)) {
          const attemptCount = (origin.revalidationAttemptCount ?? 0) + 1;
          yield* Effect.logWarning("could not revalidate queued PR monitor turn", {
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            repository: origin.repository,
            pullRequestNumber: origin.number,
            attemptCount,
            cause: snapshotResult.failure,
          });
          if (attemptCount >= MAX_MONITOR_REVALIDATION_ATTEMPTS) {
            if (origin.deliveryId === undefined) {
              yield* Effect.logWarning("queued PR monitor turn has no durable delivery to retry", {
                threadId,
                queuedTurnId: nextQueuedTurn.id,
                repository: origin.repository,
                pullRequestNumber: origin.number,
              });
              return;
            }
            yield* monitorFeedback.retryQueuedDelivery({
              deliveryId: PullRequestMonitorFeedbackDeliveryId.make(origin.deliveryId),
              reason: "Queued dispatch revalidation failed repeatedly.",
            });
            yield* orchestrationEngine.dispatch({
              type: "thread.queued-turn.delete",
              commandId: serverCommandId("queued-turn.delete-monitor-revalidation-failed"),
              threadId,
              queuedTurnId: nextQueuedTurn.id,
              deletedAt: now.toISOString(),
            });
            return;
          }
          const retryDelayMs =
            MONITOR_REVALIDATION_RETRY_BASE_MS * 2 ** Math.max(0, attemptCount - 1);
          yield* orchestrationEngine.dispatch({
            type: "thread.queued-turn.update",
            commandId: serverCommandId("queued-turn.defer-monitor-revalidation"),
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            text: nextQueuedTurn.message.text,
            origin: {
              ...origin,
              revalidationAttemptCount: attemptCount,
              nextRevalidationAt: new Date(now.getTime() + retryDelayMs).toISOString(),
            },
            updatedAt: now.toISOString(),
          });
          return;
        }
        const snapshot = snapshotResult.success;
        const sourceRevisionChanged =
          origin.sourceRevision !== undefined && snapshot.sourceRevision !== origin.sourceRevision;
        const providerStateChanged = snapshot.headSha !== origin.headSha || sourceRevisionChanged;
        const actionableEvents =
          origin.events?.filter(
            (event) =>
              reconcileFeedbackItem(
                { kind: event.kind, stableKey: feedbackStableKeyOf(event) },
                snapshot,
                {
                  checkName: event.kind === "check-failed" ? (event.detail ?? null) : null,
                  observedHeadSha,
                },
              ).kind === "actionable",
          ) ?? [];
        if (
          snapshot.state !== "open" ||
          (providerStateChanged &&
            origin.events !== undefined &&
            origin.events.length > 0 &&
            actionableEvents.length === 0)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.queued-turn.delete",
            commandId: serverCommandId("queued-turn.delete-stale-monitor"),
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            deletedAt: new Date().toISOString(),
          });
          return;
        }

        const hadRevalidationFailure =
          origin.revalidationAttemptCount !== undefined || origin.nextRevalidationAt !== undefined;
        if (providerStateChanged || hadRevalidationFailure) {
          const {
            revalidationAttemptCount: _revalidationAttemptCount,
            nextRevalidationAt: _nextRevalidationAt,
            ...stableOrigin
          } = origin;
          const refreshedOrigin = {
            ...stableOrigin,
            headSha: snapshot.headSha,
            sourceRevision: snapshot.sourceRevision,
            ...(origin.events === undefined ? {} : { events: actionableEvents }),
          };
          const refreshedText =
            providerStateChanged && origin.deliveryId !== undefined
              ? buildWakePrompt({
                  prNumber: origin.number,
                  repository: origin.repository,
                  deliveryId: origin.deliveryId,
                  ...(origin.findingContext === undefined
                    ? {}
                    : { findingContext: origin.findingContext }),
                  events: actionableEvents,
                  ...((origin.events === undefined || origin.events.length === 0) &&
                  origin.revisionSummaries !== undefined
                    ? { revisionSummaries: origin.revisionSummaries }
                    : {}),
                  snapshot,
                  readiness: computeReadiness(snapshot),
                  ...(origin.availableTools === undefined
                    ? {}
                    : { availableTools: origin.availableTools }),
                })
              : nextQueuedTurn.message.text;
          yield* orchestrationEngine.dispatch({
            type: "thread.queued-turn.update",
            commandId: serverCommandId("queued-turn.refresh-monitor"),
            threadId,
            queuedTurnId: nextQueuedTurn.id,
            text: refreshedText,
            origin: refreshedOrigin,
            updatedAt: now.toISOString(),
          });
        }
      }

      const dispatchedAt = new Date().toISOString();
      yield* orchestrationEngine
        .dispatch({
          type: "thread.queued-turn.dispatch",
          commandId: serverCommandId("queued-turn.dispatch"),
          threadId,
          queuedTurnId: nextQueuedTurn.id,
          dispatchedAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (isChildDecisionBlockedCause(cause)) {
                // Race: a child decision landed between the read model snapshot
                // and dispatch. Leave the turn queued; the meta-updated event
                // for the delegation change (or the next drain) retries it
                // after the decision is resolved.
                yield* Effect.logWarning("queued turn dispatch waiting on child decision", {
                  threadId,
                  queuedTurnId: nextQueuedTurn.id,
                });
                return;
              }
              const latestReadModel = yield* orchestrationEngine.getReadModel();
              const latestThread = latestReadModel.threads.find((entry) => entry.id === threadId);
              if (
                !latestThread ||
                !isThreadReadyForQueuedDispatch(latestThread) ||
                (nextQueuedTurn.origin?.kind === "child-nudge" &&
                  (isAutomaticChildNudgeBlocked(latestThread) ||
                    evaluateChildFollowUp(
                      latestThread,
                      nextQueuedTurn,
                      new Map(latestReadModel.threads.map((entry) => [entry.id, entry])),
                      new Date().toISOString(),
                    ).reason !== null))
              ) {
                return;
              }
              yield* failQueuedTurn({
                threadId,
                queuedTurnId: nextQueuedTurn.id,
                detail: Cause.pretty(cause),
              }).pipe(
                Effect.catchCause((failCause) =>
                  Effect.logWarning("failed to mark queued turn as failed", {
                    threadId,
                    queuedTurnId: nextQueuedTurn.id,
                    cause: Cause.pretty(failCause),
                  }),
                ),
              );
            }),
          ),
        );
    } finally {
      drainingThreadIds.delete(threadId);
      if (pendingThreadIds.delete(threadId)) {
        yield* drainThreadSafely(threadId).pipe(Effect.forkIn(wakeScope));
      }
    }
  });

  const drainThreadSafely = (threadId: ThreadId): Effect.Effect<void> =>
    drainThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to drain thread", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const requestDrain = (threadId: ThreadId): Effect.Effect<void> =>
    drainThreadSafely(threadId).pipe(Effect.forkIn(wakeScope), Effect.asVoid);

  const scheduleChildWake = (
    threadId: ThreadId,
    dueAt: string,
    kind: "collection" | "wait-deadline",
    generationId?: CommandId,
  ): Effect.Effect<void> => {
    const key = `${kind}:${threadId}:${dueAt}:${generationId ?? ""}`;
    if (scheduledChildWakes.has(key)) return Effect.void;
    scheduledChildWakes.add(key);
    return Effect.sleep(Duration.millis(Math.max(0, Date.parse(dueAt) - Date.now()))).pipe(
      Effect.andThen(Effect.suspend(() => drainThreadSafely(threadId))),
      Effect.ensuring(Effect.sync(() => scheduledChildWakes.delete(key))),
      Effect.forkIn(wakeScope),
      Effect.asVoid,
    );
  };

  const drainQueuedThreads = Effect.gen(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      readModel.threads.filter((thread) => {
        const wait = thread.nudging?.wait;
        return (
          (thread.queuedTurns ?? []).length > 0 ||
          (wait?.deadlineAt !== undefined &&
            !wait.satisfiedAt &&
            !childWaitIsSatisfied(wait) &&
            wait.assignments.some((assignment) => assignment.outcome === undefined))
        );
      }),
      (thread) => drainThreadSafely(thread.id).pipe(Effect.forkScoped),
      { concurrency: 1 },
    );
  });

  const settleThreadIfReady = (readModel: OrchestrationReadModel, thread: OrchestrationThread) =>
    Effect.gen(function* () {
      if (settleDelegation(readModel, thread)) {
        const notBefore = delegationSettlementNotBefore(thread);
        if (notBefore !== null && Date.parse(notBefore) > Date.now()) {
          yield* scheduleDelegationSettlementWake(thread.id, notBefore);
          return true;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.delegation.settle",
          commandId: serverCommandId("delegation.settle"),
          threadId: thread.id,
        });
        return true;
      }
      const stall = delegationStallEpisode(readModel, thread);
      if (!stall) return false;
      const settings = yield* serverSettings.getSettings;
      const dueAt = new Date(
        Date.parse(stall.stalledSince) + settings.delegationIdleStallThresholdMs,
      ).toISOString();
      if (Date.parse(dueAt) > Date.now()) {
        yield* scheduleDelegationStallWake(thread.id, dueAt, stall.id);
        return false;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.delegation.stall",
        commandId: CommandId.make(`server:${stall.id}`),
        threadId: thread.id,
        stallId: stall.id,
        summary: stall.summary,
        createdAt: new Date().toISOString(),
      });
      return false;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to settle child delegation", {
          threadId: thread.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  const settleThreadById = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return thread ? yield* settleThreadIfReady(readModel, thread) : false;
    });

  const scheduleDelegationSettlementWake = (
    threadId: ThreadId,
    dueAt: string,
  ): Effect.Effect<void> => {
    const key = `delegation-settlement:${threadId}:${dueAt}`;
    if (scheduledChildWakes.has(key)) return Effect.void;
    scheduledChildWakes.add(key);
    return Effect.sleep(Duration.millis(Math.max(0, Date.parse(dueAt) - Date.now()))).pipe(
      Effect.andThen(Effect.suspend(() => settleThreadById(threadId))),
      Effect.ensuring(Effect.sync(() => scheduledChildWakes.delete(key))),
      Effect.forkIn(wakeScope),
      Effect.asVoid,
    );
  };

  const scheduleDelegationStallWake = (
    threadId: ThreadId,
    dueAt: string,
    stallId: string,
  ): Effect.Effect<void> => {
    const key = `delegation-stall:${threadId}:${stallId}:${dueAt}`;
    if (scheduledChildWakes.has(key)) return Effect.void;
    scheduledChildWakes.add(key);
    return Effect.sleep(Duration.millis(Math.max(0, Date.parse(dueAt) - Date.now()))).pipe(
      Effect.andThen(Effect.suspend(() => settleThreadById(threadId))),
      Effect.ensuring(Effect.sync(() => scheduledChildWakes.delete(key))),
      Effect.forkIn(wakeScope),
      Effect.asVoid,
    );
  };

  const reconcileUnavailableChildAssignments = (
    index: ThreadReadModelIndex,
    childThreadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const child = index.threadsById.get(childThreadId);
      const assignments = (index.waitingParentsByChildId.get(childThreadId) ?? []).filter(
        (assignment) =>
          child !== undefined &&
          (child.archivedAt !== null ||
            child.deletedAt !== null ||
            child.parentThreadId !== assignment.parentThreadId ||
            child.nudging?.delegation?.assignmentId !== assignment.assignmentId),
      );
      yield* Effect.forEach(
        assignments,
        (assignment) =>
          orchestrationEngine.dispatch({
            type: "thread.child.assignment.unavailable",
            commandId: serverCommandId("child.assignment.unavailable"),
            threadId: assignment.parentThreadId,
            childThreadId,
            assignmentId: assignment.assignmentId,
          }),
        { concurrency: 1, discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("queued turn reactor failed to reconcile unavailable child assignments", {
          childThreadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const reconcileOpenDelegations = Effect.gen(function* () {
    const readModel = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      readModel.threads.filter(
        (thread) =>
          thread.nudging?.delegation?.followUp === "automatic" &&
          thread.nudging.delegation.completedAt === null,
      ),
      (thread) => settleThreadIfReady(readModel, thread),
      { concurrency: 1, discard: true },
    );
  });

  const start: QueuedTurnReactorShape["start"] = Effect.fn("start")(function* () {
    const subscription = yield* orchestrationEngine.acquireDomainEventSubscription;
    yield* Effect.forkScoped(
      Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
        Stream.runForEach((event) => {
          const threadId = threadIdForEvent(event);
          if (threadId === null) return Effect.void;
          return Effect.gen(function* () {
            if (canChangeQueuedTurnReadiness(event)) {
              yield* requestDrain(threadId);
            }
            if (canChangeDelegationSettlement(event)) {
              const readModel = yield* orchestrationEngine.getReadModel();
              const thread = readModel.threads.find((entry) => entry.id === threadId);
              const shouldReconcileAssignment = canInvalidateChildAssignment(event);
              const hasOpenDelegation = thread?.nudging?.delegation?.completedAt === null;
              if (
                !hasOpenDelegation &&
                thread?.parentThreadId == null &&
                !shouldReconcileAssignment
              ) {
                return;
              }
              if (thread) {
                yield* settleThreadIfReady(readModel, thread);
              }
              const parent =
                thread?.parentThreadId == null
                  ? undefined
                  : readModel.threads.find((entry) => entry.id === thread.parentThreadId);
              if (parent) yield* settleThreadIfReady(readModel, parent);
              if (
                event.type === "thread.meta-updated" ||
                event.type === "thread.archived" ||
                event.type === "thread.deleted" ||
                event.type === "thread.decoupled" ||
                event.type === "thread.queued-turn-created" ||
                event.type === "thread.queued-turn-updated"
              ) {
                if (parent) yield* requestDrain(parent.id);
              }
              if (shouldReconcileAssignment) {
                const index = indexReadModel(readModel);
                yield* reconcileUnavailableChildAssignments(index, threadId);
              }
            }
          });
        }),
      ),
    );
    yield* drainQueuedThreads;
    const startupIndex = indexReadModel(yield* orchestrationEngine.getReadModel());
    yield* Effect.forEach(
      startupIndex.waitingParentsByChildId.keys(),
      (childThreadId) => reconcileUnavailableChildAssignments(startupIndex, childThreadId),
      {
        concurrency: 1,
        discard: true,
      },
    );
    yield* reconcileOpenDelegations;
    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, () =>
        Effect.all([drainQueuedThreads, reconcileOpenDelegations], {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    );
    // Keep this sweep: PR-monitor revalidation retries also depend on it.
    yield* Effect.forkScoped(
      Effect.sleep(MONITOR_REVALIDATION_RETRY_INTERVAL).pipe(
        Effect.andThen(drainQueuedThreads),
        Effect.forever,
      ),
    );
  });

  return {
    start,
    wakeThread: (threadId) => drainThreadSafely(threadId as ThreadId),
  } satisfies QueuedTurnReactorShape;
});

export const QueuedTurnReactorLive = Layer.effect(QueuedTurnReactor, makeQueuedTurnReactor);
