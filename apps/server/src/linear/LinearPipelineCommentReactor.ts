import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
 * them; unchanged runs cost a database read and a hash compare, never a Linear request. Links whose
 * run is over are remembered for the process lifetime once their final state is on the issue, and a
 * restart simply rebuilds that knowledge with one idempotent pass.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const linear = yield* LinearService.LinearService;
    const store = yield* LinearLinkStore.LinearLinkStore;
    const pipelines = yield* PipelineService.PipelineService;
    const finished = new Set<string>();

    const pass = Effect.gen(function* () {
      const links = yield* store.listByCommentMode(
        "pipeline",
        yield* LinearService.pipelineCommentCutoff,
      );
      for (const stored of links) {
        if (finished.has(stored.link.linkId)) continue;
        // Failures (offline, rate limited, key rejected) are retried on the next pass.
        const isFinal = yield* linear.syncPipelineComment(stored).pipe(
          Effect.catch((error) =>
            Effect.logDebug("Linear pipeline comment sync skipped", {
              linkId: stored.link.linkId,
              reason: error.reason,
            }).pipe(Effect.as(false)),
          ),
        );
        if (isFinal) finished.add(stored.link.linkId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Linear pipeline comment pass failed", { cause }),
      ),
    );

    yield* forkParked(
      Stream.merge(
        pipelines.subscribeLiveRuns().pipe(Stream.map(() => undefined)),
        Stream.tick(RETRY_INTERVAL),
      ).pipe(
        Stream.debounce(DEBOUNCE),
        Stream.runForEach(() => pass),
        Effect.catchCause((cause) =>
          Effect.logWarning("Linear pipeline comment reactor stopped", { cause }),
        ),
      ),
    );
  }),
);
