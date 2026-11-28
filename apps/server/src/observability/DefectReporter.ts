import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";

// RpcServer reports typed failures too; log only defects.
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
