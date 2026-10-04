import type {
  CollaborationRequest,
  CollaborativeAcceptanceCandidateId,
  CollaborativeAcceptanceCaseId,
  CommandId,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { REVIEW_CHANGES_WORKFLOW_ID } from "@t3tools/shared/workflows/reviewChanges";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  threadBlocksSettlement,
  threadHasInFlightTurn,
  threadHasPendingInteraction,
} from "../orchestration/commandInvariants.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkflowCoordinatorReactor } from "../orchestration/Services/WorkflowCoordinatorReactor.ts";
import { runReviewChangesWorkflow } from "../orchestration/reviewChangesWorkflow.ts";
import { CollaborativeAcceptanceCoordinator } from "../collaborativeAcceptance/Coordinator.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { repositoryFromPullRequestUrl } from "./canonicalKey.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";
import { isReviewWorkflowThread } from "./reviewWorkflowThread.ts";

const RECONCILIATION_INTERVAL = "30 seconds";

export interface CreatedPullRequestReviewObservation {
  readonly state: "open" | "closed" | "merged";
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly sourceRevision: string;
}

export interface CreatedPullRequestReviewReconciliation {
  readonly runExclusive?: (
    link: ThreadPullRequestLink,
    effect: Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, unknown>;
  readonly refresh: (
    link: ThreadPullRequestLink,
  ) => Effect.Effect<CreatedPullRequestReviewObservation | null, unknown>;
  readonly readCurrentThread: () => Effect.Effect<OrchestrationThread | null>;
  readonly submit: (input: {
    readonly thread: OrchestrationThread;
    readonly link: ThreadPullRequestLink;
    readonly observation: CreatedPullRequestReviewObservation;
  }) => Effect.Effect<void, unknown>;
  readonly settleMergedCreator?: (input: {
    readonly thread: OrchestrationThread;
    readonly link: ThreadPullRequestLink;
  }) => Effect.Effect<void, unknown>;
}

export function createdPullRequestLinks(
  thread: Pick<OrchestrationThread, "pullRequests">,
): ReadonlyArray<ThreadPullRequestLink> {
  return (thread.pullRequests ?? []).filter(
    (link) => link.source === "created" || link.source === "agent",
  );
}

export function creatorIsInactive(thread: OrchestrationThread): boolean {
  return !threadHasInFlightTurn(thread) && !threadHasPendingInteraction(thread);
}

/**
 * A merge is the end of the creating thread's work, so the thread sinks out of
 * the inbox instead of being reviewed again. `settledOverride` decides
 * eligibility: an already settled thread needs nothing, and "active" is the
 * user's own reopen (or pin), which suppresses automatic settlement so a
 * deliberately reopened thread is not dragged back under.
 */
export function mergedPullRequestSettlesCreator(
  thread: OrchestrationThread,
  options: { readonly now: string },
): boolean {
  return (thread.settledOverride ?? null) === null && !threadBlocksSettlement(thread, options);
}

export interface ReferenceCountedKeyedLock {
  readonly withLock: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly size: () => number;
}

export function makeReferenceCountedKeyedLock(): ReferenceCountedKeyedLock {
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

  return {
    withLock: (key, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const entry = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          entry.users += 1;
          locks.set(key, entry);
          return entry;
        }),
        (entry) => entry.semaphore.withPermit(effect),
        (entry) =>
          Effect.sync(() => {
            if (locks.get(key) !== entry) return;
            entry.users -= 1;
            if (entry.users === 0) locks.delete(key);
          }),
      ),
    size: () => locks.size,
  };
}

export const reconcileCreatedPullRequestReview = (
  thread: OrchestrationThread,
  reconciliation: CreatedPullRequestReviewReconciliation,
  options: { readonly now?: string } = {},
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      isReviewWorkflowThread(thread) ||
      !creatorIsInactive(thread)
    ) {
      return;
    }

    const now = options.now ?? new Date().toISOString();
    for (const link of createdPullRequestLinks(thread)) {
      const reconcileLink = Effect.gen(function* () {
        const observation = yield* reconciliation.refresh(link);
        if (observation === null) return;

        const latestThread = yield* reconciliation.readCurrentThread();
        if (
          latestThread === null ||
          latestThread.deletedAt !== null ||
          latestThread.archivedAt !== null ||
          isReviewWorkflowThread(latestThread) ||
          !creatorIsInactive(latestThread) ||
          !createdPullRequestLinks(latestThread).some(
            (candidate) =>
              candidate.source === link.source &&
              pullRequestKey(candidate) === pullRequestKey(link),
          )
        ) {
          return;
        }

        if (observation.state === "merged") {
          if (
            reconciliation.settleMergedCreator !== undefined &&
            mergedPullRequestSettlesCreator(latestThread, { now })
          ) {
            yield* reconciliation.settleMergedCreator({ thread: latestThread, link });
          }
          return;
        }
        if (observation.state !== "open") return;

        yield* reconciliation.submit({
          thread: latestThread,
          link,
          observation,
        });
      });
      yield* reconciliation.runExclusive?.(link, reconcileLink) ?? reconcileLink;
    }
  });

function threadIdFromEvent(event: OrchestrationEvent): OrchestrationThread["id"] | null {
  if (event.aggregateKind !== "thread") return null;
  return event.aggregateId as OrchestrationThread["id"];
}

const pullRequestKey = (link: ThreadPullRequestLink): string =>
  `${link.pullRequest.url}:${link.pullRequest.number}`;

/**
 * Derived from the outcome so a repeated reconciliation deduplicates through
 * the recorded command receipt instead of re-settling or erroring.
 */
const mergedPullRequestSettleCommandId = (
  thread: OrchestrationThread,
  link: ThreadPullRequestLink,
): CommandId => `server:merged-pr-settle:${thread.id}:${pullRequestKey(link)}` as CommandId;

export const dispatchAutomaticReviewWorkflow = <CancelError, WorkflowError>(input: {
  readonly request: {
    readonly caseId: CollaborativeAcceptanceCaseId;
    readonly candidateId: CollaborativeAcceptanceCandidateId;
    readonly headSha: string;
    readonly workflowId: string;
    readonly idempotencyKey: string;
  };
  readonly pullRequest: {
    readonly repository: string;
    readonly number: number;
  };
  readonly observationState?: "open" | "closed" | "merged";
  readonly readCurrentThread: () => Effect.Effect<OrchestrationThread | null>;
  readonly cancelLegacySelfReview: (
    thread: OrchestrationThread,
    request: CollaborationRequest,
  ) => Effect.Effect<void, CancelError>;
  readonly runWorkflow: (input: {
    readonly thread: OrchestrationThread;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<unknown, WorkflowError>;
}) =>
  Effect.gen(function* () {
    if (input.request.workflowId !== REVIEW_CHANGES_WORKFLOW_ID) {
      return yield* Effect.fail(
        new Error(`Unsupported automatic review workflow '${input.request.workflowId}'.`),
      );
    }
    if (input.observationState !== undefined && input.observationState !== "open") return;
    const expectedNumber = input.pullRequest.number;
    const expectedRepository = input.pullRequest.repository.toLowerCase();
    const refreshedThread = yield* input.readCurrentThread();
    if (refreshedThread === null || !creatorIsInactive(refreshedThread)) return;
    const stillLinked = createdPullRequestLinks(refreshedThread).some((link) => {
      if (link.pullRequest.number !== expectedNumber) return false;
      const linkRepository = repositoryFromPullRequestUrl(link.pullRequest.url);
      return linkRepository !== null && linkRepository.toLowerCase() === expectedRepository;
    });
    if (!stillLinked) return;
    yield* Effect.forEach(
      (refreshedThread.collaborationRequests ?? []).filter(
        (candidate) =>
          candidate.kind === "review" &&
          candidate.status === "waiting" &&
          candidate.senderThreadId === refreshedThread.id &&
          candidate.recipientThreadId === refreshedThread.id &&
          candidate.caseId === input.request.caseId &&
          candidate.candidateRefs.includes(input.request.candidateId),
      ),
      (candidate) => input.cancelLegacySelfReview(refreshedThread, candidate),
      { discard: true },
    );
    yield* input.runWorkflow({
      thread: refreshedThread,
      pullRequestNumber: expectedNumber,
      headSha: input.request.headSha,
      idempotencyKey: input.request.idempotencyKey,
    });
  });

const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const monitors = yield* PullRequestMonitorService;
  const acceptance = yield* CollaborativeAcceptanceCoordinator;
  const git = yield* GitCore;
  const serverSettings = yield* ServerSettingsService;
  const workflowCoordinator = yield* Effect.serviceOption(WorkflowCoordinatorReactor);
  const pullRequestLocks = makeReferenceCountedKeyedLock();

  const cancelLegacySelfReview = (thread: OrchestrationThread, request: CollaborationRequest) =>
    engine
      .dispatch({
        type: "thread.collaboration-request.cancel",
        commandId: `acceptance:cancel-legacy-self-review:${request.requestId}` as CommandId,
        threadId: thread.id,
        requestId: request.requestId,
        actorAuthority: request.senderAuthority,
        createdAt: new Date().toISOString(),
      })
      .pipe(Effect.asVoid);

  const currentThread = (threadId: OrchestrationThread["id"]) =>
    Effect.gen(function* () {
      const readModel = yield* engine.getReadModel();
      return readModel.threads.find((thread) => thread.id === threadId) ?? null;
    });

  const reconcileThread = (thread: OrchestrationThread) =>
    Effect.gen(function* () {
      yield* reconcileCreatedPullRequestReview(thread, {
        runExclusive: (link, effect) =>
          pullRequestLocks.withLock(`${thread.id}:${pullRequestKey(link)}`, effect),
        refresh: (link) => {
          const repository = repositoryFromPullRequestUrl(link.pullRequest.url);
          if (repository === null) return Effect.succeed(null);
          return Effect.gen(function* () {
            const refreshed = yield* monitors.start({
              projectId: thread.projectId,
              repository,
              number: link.pullRequest.number,
              ownerThreadId: thread.id,
              ownerMode: "preserve",
            });
            const context = yield* monitors.context({ monitorId: refreshed.monitor.id });
            const snapshot = context.latestSnapshot;
            return snapshot === null
              ? null
              : {
                  state: snapshot.state,
                  repository: snapshot.repository,
                  number: snapshot.number,
                  headSha: snapshot.headSha,
                  sourceRevision: snapshot.sourceRevision,
                };
          });
        },
        readCurrentThread: () => currentThread(thread.id),
        settleMergedCreator: ({ thread: latestThread, link: mergedLink }) =>
          engine
            .dispatch({
              type: "thread.settle",
              commandId: mergedPullRequestSettleCommandId(latestThread, mergedLink),
              threadId: latestThread.id,
            })
            .pipe(Effect.asVoid),
        submit: ({ thread: latestThread, observation }) =>
          Effect.gen(function* () {
            const reconciled = yield* acceptance.reconcileAutomaticCandidate({
              parentThreadId: latestThread.id,
              pullRequest: {
                projectId: latestThread.projectId,
                repository: observation.repository,
                number: observation.number,
              },
              headSha: observation.headSha,
              sourceRevision: observation.sourceRevision,
            });
            const request = reconciled.workflowRequest;
            if (request === null) return;
            yield* dispatchAutomaticReviewWorkflow({
              request,
              pullRequest: {
                repository: observation.repository,
                number: observation.number,
              },
              observationState: observation.state,
              readCurrentThread: () => currentThread(latestThread.id),
              cancelLegacySelfReview,
              runWorkflow: ({ thread, pullRequestNumber, headSha, idempotencyKey }) =>
                runReviewChangesWorkflow(
                  {
                    git,
                    orchestrationEngine: engine,
                    projectionSnapshotQuery: projections,
                    serverSettings,
                    workflowCoordinator,
                  },
                  {
                    workflowId: REVIEW_CHANGES_WORKFLOW_ID,
                    threadId: thread.id,
                    projectId: thread.projectId,
                    input: {
                      scope: "pull-request",
                      pullRequestNumber,
                    },
                    destinationMode: "child-chat",
                    trigger: "after-assistant-turn-completes",
                    idempotencyKey,
                  },
                  {
                    expectedHeadSha: headSha,
                    expectedPullRequest: { repository: observation.repository },
                  },
                ),
            });
          }),
      });
    });

  const reconcileThreadSafely = (thread: OrchestrationThread) =>
    reconcileThread(thread).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("created pull-request review reconciliation failed", {
          threadId: thread.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const reconcileAll = Effect.gen(function* () {
    const readModel: OrchestrationReadModel = yield* engine.getReadModel();
    yield* Effect.forEach(
      readModel.threads.filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          !isReviewWorkflowThread(thread) &&
          createdPullRequestLinks(thread).length > 0 &&
          creatorIsInactive(thread),
      ),
      reconcileThreadSafely,
      { concurrency: 2, discard: true },
    );
  });

  const subscription = yield* engine.acquireDomainEventSubscription;
  yield* Effect.forkScoped(
    Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
      Stream.runForEach((event) => {
        const threadId = threadIdFromEvent(event);
        if (threadId === null) return Effect.void;
        return currentThread(threadId).pipe(
          Effect.flatMap((thread) =>
            thread === null ? Effect.void : reconcileThreadSafely(thread),
          ),
        );
      }),
    ),
  );
  yield* Effect.forkScoped(
    reconcileAll.pipe(Effect.repeat(Schedule.spaced(RECONCILIATION_INTERVAL))),
  );
});

export const layer = Layer.effectDiscard(makeReactor);
