import { OrchestratorMcpFailure, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { newCommandId, readWritableThread, unavailable } from "../../threadAccess.ts";
import { ThreadToolkit } from "./tools.ts";

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  t3_thread_organize: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readWritableThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
});
