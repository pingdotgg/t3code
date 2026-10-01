import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

import type { ProjectId } from "@t3tools/contracts";
import { threadPullRequestKey } from "@t3tools/shared/threadPullRequests";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  liveReviewThreadPullRequests,
  planReviewThreadAutoArchive,
  reviewThreadMergeArchiveCommandId,
} from "./reviewThreadMergeArchive.ts";
import { PullRequestMonitorService } from "./PullRequestMonitorService.ts";

const SWEEP_INTERVAL = "5 minutes";
const LOG_TAG = "review-thread-merge-archive";

type SweepServices =
  | OrchestrationEngineService
  | PullRequestMonitorService
  | PullRequestService
  | ServerSettingsService;

/**
 * One pass. A merge is only ever observed by polling, so this runs on a timer rather than off a
 * domain event: a missed or crashed pass is corrected by the next one.
 */
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

  // A review thread that already records the merge needs no provider read. Only the rest are
  // worth asking about, and those are grouped so a project costs one call rather than one per
  // pull request — the fan-out that a per-pull-request read would create is a rate-limit risk.
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
      // Entries are newest-first, so a recent merge is still on this page; an older one may be
      // missed until the thread's own state refreshes. Worth saying out loud rather than hiding.
      yield* Effect.logWarning(`${LOG_TAG}: merged pull request listing was truncated`, {
        projectId,
      });
    }
    for (const entry of listing.entries) {
      mergedPullRequestKeys.add(threadPullRequestKey({ url: entry.url, number: entry.number }));
    }
  }

  // A monitored pull request answers from local state, which is cheaper and more current than
  // the listing above; it only settles the answer for keys the listing did not already carry.
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

  // The provider reads above took real time, during which the user can settle a thread, start a
  // turn, or unlink the pull request. The archive decider only refuses a thread that is already
  // archived, so eligibility is re-read here rather than dispatched on a stale read model. What
  // remains is ordinary command ordering: a user action dispatched after this point wins, and one
  // dispatched before it is already reflected above.
  const current = yield* engine.getReadModel();
  for (const candidate of planReviewThreadAutoArchive(current, mergedPullRequestKeys)) {
    yield* engine
      .dispatch({
        type: "thread.archive",
        commandId: reviewThreadMergeArchiveCommandId(candidate),
        threadId: candidate.threadId,
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
  }
}) satisfies Effect.Effect<void, never, SweepServices>;

const makeReactor = Effect.gen(function* () {
  yield* Effect.forkScoped(sweepOnce.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));
});

export const layer = Layer.effectDiscard(makeReactor);
