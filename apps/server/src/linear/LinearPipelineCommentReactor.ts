import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as PipelineService from "../pipelines/PipelineService.ts";
import { forkParked } from "../serverActivation.ts";
import * as LinearLinkStore from "./LinearLinkStore.ts";
import * as LinearService from "./LinearService.ts";

/** Pipeline steps change in bursts; one edit per quiet second is enough for an issue comment. */
const DEBOUNCE = Duration.seconds(1);
/** Safety net for edits that failed while Linear was unreachable and saw no later pipeline event. */
const RETRY_INTERVAL = Duration.minutes(1);

/**
 * Keeps the one comment per pipeline link current. Each pass walks recent pipeline links and syncs
 * them; unchanged runs cost a database read and a hash compare, never a Linear request. Finished
 * runs stay in the walk because a step rerun brings them back to life.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const linear = yield* LinearService.LinearService;
    const store = yield* LinearLinkStore.LinearLinkStore;
    const pipelines = yield* PipelineService.PipelineService;

    const pass = Effect.gen(function* () {
      const links = yield* store.listByCommentMode(
        "pipeline",
        yield* LinearService.pipelineCommentCutoff,
      );
      for (const stored of links) {
        // A run on another machine is not readable here; its comment is a one-off post.
        if (stored.link.environmentId != null) continue;
        // Failures (offline, rate limited, key rejected) are retried on the next pass.
        yield* linear.syncPipelineComment(stored).pipe(
          Effect.catch((error) =>
            Effect.logDebug("Linear pipeline comment sync skipped", {
              linkId: stored.link.linkId,
              reason: error.reason,
            }),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Linear pipeline comment pass failed", { cause }),
      ),
    );

    // A failed pipeline read resubscribes later instead of ending the merge (and its tick).
    const runChanges = pipelines.subscribeLiveRuns().pipe(
      Stream.tapError((error) =>
        Effect.logWarning("Linear pipeline comment reactor lost pipeline updates", {
          message: error.message,
        }),
      ),
      Stream.retry(Schedule.spaced(RETRY_INTERVAL)),
      Stream.map(() => undefined),
    );

    yield* forkParked(
      Stream.merge(runChanges, Stream.tick(RETRY_INTERVAL)).pipe(
        Stream.debounce(DEBOUNCE),
        Stream.runForEach(() => pass),
        Effect.catchCause((cause) =>
          Effect.logWarning("Linear pipeline comment reactor stopped", { cause }),
        ),
      ),
    );
  }),
);
