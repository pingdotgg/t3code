import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Raised when an EMR Serverless application never settles into the expected
 * state within the bounded polling budget.
 */
export class EmrServerlessStateTimeout extends Data.TaggedError(
  "EmrServerlessStateTimeout",
)<{
  readonly applicationId: string;
  readonly expected: readonly string[];
  readonly actual: string | undefined;
  readonly stateDetails: string | undefined;
}> {}

/**
 * Poll `getApplication` (bounded, spaced 5s, ~2 min budget) until the
 * application leaves the given transitional state. Explicitly typed so
 * `Effect.repeat`'s conditional return type does not widen the provider layer
 * in declaration emit (see PATTERNS §7).
 */
const untilNotInState = <E, R>(
  self: Effect.Effect<emr.GetApplicationResponse, E, R>,
  transitional: readonly string[],
): Effect.Effect<emr.Application, E, R> =>
  Effect.repeat(
    Effect.map(self, (response) => response.application),
    {
      schedule: Schedule.spaced("5 seconds"),
      until: (application) => !transitional.includes(application.state),
      times: 24,
    },
  );

/**
 * Await an application leaving `CREATING`, failing with
 * `EmrServerlessStateTimeout` if it does not settle into `CREATED` (or an
 * auto-started `STARTING`/`STARTED`) within the budget.
 */
export const awaitApplicationCreated = Effect.fn(
  "AWS.EMRServerless.awaitApplicationCreated",
)(function* (applicationId: string) {
  const application = yield* untilNotInState(
    emr.getApplication({ applicationId }),
    ["CREATING"],
  );
  const settled = ["CREATED", "STARTING", "STARTED"];
  if (!settled.includes(application.state)) {
    return yield* Effect.fail(
      new EmrServerlessStateTimeout({
        applicationId,
        expected: settled,
        actual: application.state,
        stateDetails: application.stateDetails,
      }),
    );
  }
  return application;
});

/**
 * Await an application settling into an updatable/deletable state (`CREATED`
 * or `STOPPED`), draining `STARTING`/`STOPPING` transitions. The caller is
 * responsible for issuing `stopApplication` first when the application is
 * `STARTED`.
 */
export const awaitApplicationStopped = Effect.fn(
  "AWS.EMRServerless.awaitApplicationStopped",
)(function* (applicationId: string) {
  const application = yield* untilNotInState(
    emr.getApplication({ applicationId }),
    ["CREATING", "STARTING", "STOPPING"],
  );
  // TERMINATED is tolerated: a concurrent delete winning the race is a settled
  // outcome for both the update path (the follow-up call surfaces the truth)
  // and the delete path (nothing left to delete).
  const settled = ["CREATED", "STOPPED", "TERMINATED"];
  if (!settled.includes(application.state)) {
    return yield* Effect.fail(
      new EmrServerlessStateTimeout({
        applicationId,
        expected: settled,
        actual: application.state,
        stateDetails: application.stateDetails,
      }),
    );
  }
  return application;
});
