import type { PullRequestRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

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

const makeReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const monitors = yield* PullRequestMonitorService;
  const pullRequests = yield* PullRequestService;
  const serverSettings = yield* ServerSettingsService;

  /**
   * Only the poll loop observes a merge, so the monitor is the authority on one. A monitor that
   * already went terminal still answers with its last snapshot, and a review whose pull request
   * was never monitored falls back to a single cached read.
   */
  const isMerged = (ref: PullRequestRef) =>
    Effect.gen(function* () {
      const monitored = yield* Effect.result(
        monitors.status({ reference: ref }).pipe(Effect.catch(() => Effect.succeed(null))),
      );
      const snapshot = Result.isSuccess(monitored)
        ? (monitored.success?.latestSnapshot ?? null)
        : null;
      if (snapshot !== null) return snapshot.state === "merged";
      return yield* pullRequests.detail(ref).pipe(
        Effect.map((detail) => detail.state === "merged"),
        Effect.catch(() => Effect.succeed(false)),
      );
    });

  const sweep = Effect.gen(function* () {
    const settings = yield* Effect.result(serverSettings.getSettings);
    if (Result.isFailure(settings) || settings.success.autoArchiveReviewThreadsOnMerge !== true) {
      return;
    }
    const readModel = yield* engine.getReadModel();
    const mergedPullRequestKeys = new Set<string>();
    for (const live of liveReviewThreadPullRequests(readModel)) {
      // A review thread that already records the merge is archived on this pass; only an
      // unrecorded one costs a provider read.
      if (live.recordedState !== "merged" && !(yield* isMerged(live.ref))) continue;
      for (const key of live.pullRequestKeys) mergedPullRequestKeys.add(key);
    }
    for (const candidate of planReviewThreadAutoArchive(readModel, mergedPullRequestKeys)) {
      yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: reviewThreadMergeArchiveCommandId(candidate),
          threadId: candidate.threadId,
        })
        .pipe(
          Effect.tapCause((cause) =>
            Effect.logDebug("review thread auto-archive skipped", {
              threadId: candidate.threadId,
              pullRequestKey: candidate.pullRequestKey,
              cause: cause,
            }),
          ),
          Effect.catchCause(() => Effect.void),
        );
    }
  });

  yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));
});

export const layer = Layer.effectDiscard(makeReactor);
