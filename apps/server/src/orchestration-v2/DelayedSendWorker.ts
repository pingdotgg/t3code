import { CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Releases scheduled sends whose time has come. A release only clears the
 * schedule; the queue then decides delivery, so a held queue (Stop, restart
 * recovery) keeps the message until the user resumes it.
 */
export const releaseDueScheduledRuns = Effect.fn("DelayedSendWorker.releaseDue")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const due = yield* projections.getDueScheduledRuns(yield* DateTime.now);
  for (const run of due) {
    yield* threads
      .dispatch({
        type: "queued-run.release",
        commandId: CommandId.make(
          `scheduled-release:${run.runId}:${DateTime.toEpochMillis(run.releaseAt)}`,
        ),
        threadId: run.threadId,
        runId: run.runId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.scheduled-release.dispatch-failed", {
            threadId: run.threadId,
            runId: run.runId,
            cause,
          }),
        ),
      );
  }
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("scheduled-send-release", releaseDueScheduledRuns());
  }),
);
