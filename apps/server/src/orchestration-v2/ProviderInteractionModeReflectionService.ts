import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import {
  type ProviderInteractionModeReflection,
  ProviderInteractionModeReflections,
} from "./ProviderInteractionModeReflections.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const MAX_REFLECTION_ATTEMPTS = 3;
const REFLECTION_RETRY_DELAY = "100 millis";

/**
 * Drains ProviderInteractionModeReflections and applies each one as an
 * ordinary `thread.interaction-mode.set` command, so the update flows through
 * the same handler, event, and projection path as a user toggling the mode.
 * Already-matching and archived threads are skipped; the command id derives
 * from the reflection's thread and dedupe key, so a duplicated native event
 * cannot apply twice.
 */
export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const requests = yield* ProviderInteractionModeReflections;
    const threads = yield* ThreadManagementService;

    const applyReflection = Effect.fn("ProviderInteractionModeReflectionService.apply")(function* (
      request: ProviderInteractionModeReflection,
    ) {
      const projection = yield* threads.getThreadProjection(request.threadId);
      if (
        projection.thread.archivedAt !== null ||
        projection.thread.interactionMode === request.interactionMode
      ) {
        return;
      }
      yield* threads.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(
          `interaction-mode-reflection:${request.threadId}:${request.dedupeKey}`,
        ),
        threadId: request.threadId,
        interactionMode: request.interactionMode,
      });
    });

    const applyReflectionWithRetry = (request: ProviderInteractionModeReflection) =>
      applyReflection(request).pipe(
        Effect.retry({
          times: MAX_REFLECTION_ATTEMPTS - 1,
          schedule: Schedule.spaced(REFLECTION_RETRY_DELAY),
        }),
        Effect.catchCause(() =>
          Effect.logWarning("orchestration-v2.interaction-mode-reflection.apply-failed", {
            driver: request.driver,
            interactionMode: request.interactionMode,
            retrying: false,
            threadId: request.threadId,
          }),
        ),
      );

    yield* requests.take.pipe(
      Effect.flatMap(applyReflectionWithRetry),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
