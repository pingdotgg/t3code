import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";

/**
 * RpcServer reports every failed handler exit; typed failures are expected responses, so only
 * dies are logged.
 */
const reporter: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    for (const reason of cause.reasons) {
      if (reason._tag !== "Die" || ErrorReporter.isIgnored(reason.defect)) continue;
      Effect.runForkWith(fiber.context)(
        Effect.logError("Unhandled defect", Cause.fromReasons([reason])),
      );
    }
  },
};

export const layer = ErrorReporter.layer([reporter]);
