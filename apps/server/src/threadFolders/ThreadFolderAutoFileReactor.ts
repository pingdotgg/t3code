import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadFolderService from "./ThreadFolderService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    const folders = yield* ThreadFolderService.ThreadFolderService;
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        switch (event.type) {
          case "thread.created":
          case "thread.metadata-updated":
          case "thread.pull-request-synced":
          case "thread.provider-switched":
          case "thread.pull-request-link-updated":
            return folders.autoFile(event.threadId).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("thread folder auto-file skipped", {
                    threadId: event.threadId,
                    cause,
                  }),
              ),
            );
          default:
            return Effect.void;
        }
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logWarning("thread folder auto-file event stream failed", { cause }),
        ),
      ),
    );
  }),
);
