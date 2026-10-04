import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ProjectId } from "@t3tools/contracts";
import { threadPullRequestKey } from "@t3tools/shared/threadPullRequests";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AutomaticArchiveGuardRegistry } from "../orchestration/Services/AutomaticArchiveGuardRegistry.ts";
import {
  canAdmitAutomaticArchiveNow,
  liveReviewThreadPullRequests,
  planReviewThreadAutoArchive,
  reviewThreadMergeArchiveCommandId,
  shouldTriggerMergeArchiveSweep,
} from "./reviewThreadMergeArchive.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";

const SWEEP_INTERVAL = "1 minute";
const LOG_TAG = "review-thread-merge-archive";

type SweepServices =
  | OrchestrationEngineService
  | PullRequestMonitorService
  | PullRequestService
  | ServerSettingsService;

// The merged listing is cached for 30s and grouped by project, so a 1-minute
// sweep costs at most one host read per project with live review threads.
export const sweepOnce = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const monitors = yield* PullRequestMonitorService;
  const pullRequests = yield* PullRequestService;
  const serverSettings = yield* ServerSettingsService;

  const settings = yield* Effect.result(serverSettings.getSettings);
  if (Result.isFailure(settings) || settings.success.autoArchiveReviewThreadsOnMerge !== true) {
    return;
  }
  const readModel = yield* engine.getReadModel();
  const live = liveReviewThreadPullRequests(readModel);
  const mergedPullRequestKeys = new Set<string>();

  // Grouped by project so the fallback costs one read per project, not one per pull request.
  const unrecordedProjects = new Set<ProjectId>();
  for (const review of live) {
    if (review.recordedState === "merged") {
      for (const key of review.pullRequestKeys) mergedPullRequestKeys.add(key);
      continue;
    }
    unrecordedProjects.add(review.ref.projectId);
  }

  for (const projectId of unrecordedProjects) {
    const listing = yield* pullRequests.list({ state: "merged", projectId }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`${LOG_TAG}: merged pull request listing failed`, {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.as(null)),
      ),
    );
    if (listing === null) continue;
    if (listing.truncated) {
      // Newest-first, so a recent merge is still here; an older one waits for the thread's state.
      yield* Effect.logWarning(`${LOG_TAG}: merged pull request listing was truncated`, {
        projectId,
      });
    }
    for (const entry of listing.entries) {
      mergedPullRequestKeys.add(threadPullRequestKey({ url: entry.url, number: entry.number }));
    }
  }

  for (const review of live) {
    if (review.recordedState === "merged") continue;
    if (review.pullRequestKeys.some((key) => mergedPullRequestKeys.has(key))) continue;
    const monitored = yield* monitors.status({ reference: review.ref }).pipe(
      Effect.catch((error) =>
        Effect.logDebug(`${LOG_TAG}: monitor read failed`, {
          projectId: review.ref.projectId,
          number: review.ref.number,
          error: error instanceof Error ? error.message : String(error),
        }).pipe(Effect.as(null)),
      ),
    );
    if (monitored?.latestSnapshot?.state === "merged") {
      for (const key of review.pullRequestKeys) mergedPullRequestKeys.add(key);
    }
  }

  const current = yield* engine.getReadModel();
  for (const candidate of planReviewThreadAutoArchive(current, mergedPullRequestKeys)) {
    yield* engine
      .dispatch({
        type: "thread.archive",
        commandId: reviewThreadMergeArchiveCommandId(candidate),
        threadId: candidate.threadId,
        automatic: true,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`${LOG_TAG}: archive dispatch failed`, {
            threadId: candidate.threadId,
            pullRequestKey: candidate.pullRequestKey,
            cause,
          }),
        ),
      );

    // Dispatch reports no event count, so a refusal is only visible by reading the outcome back.
    const settled = yield* engine.getReadModel();
    if (settled.threads.find((thread) => thread.id === candidate.threadId)?.archivedAt == null) {
      yield* Effect.logDebug(`${LOG_TAG}: archive deferred at admission`, {
        threadId: candidate.threadId,
        pullRequestKey: candidate.pullRequestKey,
      });
    }
  }
}) satisfies Effect.Effect<void, never, SweepServices>;

const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const guards = yield* AutomaticArchiveGuardRegistry;
  yield* guards.register(({ readModel, threadId }) =>
    canAdmitAutomaticArchiveNow(readModel, threadId),
  );
  // A merged link write already proves the merge, so sweep eagerly instead of
  // waiting for the next tick. Sweeping is idempotent (deterministic command
  // ids dedupe through receipts, listings hit the 30s cache), so overlapping
  // periodic and eager runs only cost a cheap re-read.
  const subscription = yield* engine.acquireDomainEventSubscription;
  yield* Effect.forkScoped(
    Stream.forever(Stream.fromEffect(PubSub.take(subscription))).pipe(
      Stream.runForEach((event) =>
        shouldTriggerMergeArchiveSweep(event)
          ? sweepOnce.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(`${LOG_TAG}: eager merge archive sweep failed`, { cause }),
              ),
            )
          : Effect.void,
      ),
    ),
  );
  yield* Effect.forkScoped(sweepOnce.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));
});

export const layer = Layer.effectDiscard(makeReactor);
