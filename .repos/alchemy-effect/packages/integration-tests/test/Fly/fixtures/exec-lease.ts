import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

// Transport failures and response-read defects can retain the private lease header.
export const sanitizeExecFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(
        Cause.fromReasons(
          cause.reasons.map((reason) =>
            Cause.isFailReason(reason)
              ? Cause.makeFailReason(new Error("Fly exec lease probe failed"))
              : Cause.isDieReason(reason)
                ? Cause.makeDieReason(new Error("Fly exec lease probe defect"))
                : Cause.makeInterruptReason(reason.fiberId),
          ),
        ),
      ),
    ),
  );
