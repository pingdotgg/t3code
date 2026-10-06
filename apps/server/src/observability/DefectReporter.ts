import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";

/**
 * Logs the defects of WebSocket RPC handlers. RpcServer reports every failed
 * handler exit; typed failures are expected responses, so only dies are logged.
 */
const reporter: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    for (const reason of cause.reasons) {
      if (reason._tag !== "Die" || ErrorReporter.isIgnored(reason.defect)) continue;
      // Reporters are called synchronously from the failing fiber. Logging with
      // its context keeps its loggers and annotations, and a fork cannot throw
      // back into the server that reported.
      Effect.runForkWith(fiber.context)(
        Effect.logError("Unhandled defect", Cause.fromReasons([reason])),
      );
    }
  },
};

export const layer = ErrorReporter.layer([reporter]);
