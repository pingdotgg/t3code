import * as osis from "@distilled.cloud/aws/osis";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Convert OSIS's `[{ Key, Value }]` tag list into a plain record, dropping
 * any entry missing a key or value.
 */
export const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

/**
 * Read the observed tags for an OSIS pipeline by ARN. A pipeline that has
 * just been created (or is mid-transition) can transiently reject the call;
 * treat any failure as "no observed tags" so tag reconciliation still runs.
 */
export const readPipelineTags = Effect.fn(function* (arn: string) {
  const response = yield* osis
    .listTagsForResource({ Arn: arn })
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return toTagRecord(response?.Tags);
});

/**
 * An OSIS pipeline whose asynchronous create/update converged to a
 * `*_FAILED` status.
 */
export class PipelineOperationFailed extends Data.TaggedError(
  "OsisPipelineOperationFailed",
)<{
  readonly pipelineName: string;
  readonly status: string;
  readonly reason: string | undefined;
}> {}

const isTransitional = (status: string | undefined): boolean =>
  status === "CREATING" ||
  status === "UPDATING" ||
  status === "STARTING" ||
  status === "STOPPING" ||
  status === "DELETING";

const isFailedStatus = (status: string | undefined): boolean =>
  status === "CREATE_FAILED" ||
  status === "UPDATE_FAILED" ||
  status === "START_FAILED";

/**
 * Poll an OSIS pipeline until its `Status` reaches a terminal value
 * (bounded: 15s x 60 = ~15 minutes; pipeline creation typically takes 5-10
 * minutes). `*_FAILED` fails immediately with the status reason. If the
 * bounded schedule exhausts while still transitional, the last observation
 * is returned as-is so the caller sees the real (still-converging) pipeline
 * rather than a spurious failure.
 *
 * The explicit `Effect.Effect<A, E, R>` return annotation is load-bearing:
 * inlining repeat/retry combinators in provider lifecycle code lets their
 * conditional return types survive into declaration emit and widen the
 * provider layer to `unknown` R, poisoning `AWS.providers()` downstream.
 */
export const waitForPipelineSettled = <E extends { readonly _tag: string }, R>(
  pipelineName: string,
  read: Effect.Effect<osis.Pipeline | undefined, E, R>,
): Effect.Effect<osis.Pipeline | undefined, E | PipelineOperationFailed, R> =>
  Effect.flatMap(
    Effect.repeat(read, {
      schedule: Schedule.max([
        Schedule.fixed("15 seconds"),
        Schedule.recurs(60),
      ]),
      until: (pipeline) =>
        pipeline === undefined || !isTransitional(pipeline.Status),
    }),
    (
      pipeline,
    ): Effect.Effect<osis.Pipeline | undefined, PipelineOperationFailed> =>
      pipeline !== undefined && isFailedStatus(pipeline.Status)
        ? Effect.fail(
            new PipelineOperationFailed({
              pipelineName,
              status: pipeline.Status!,
              reason: pipeline.StatusReason?.Description,
            }),
          )
        : Effect.succeed(pipeline),
  );

/**
 * Retry an effect while OSIS reports `ConflictException` — raised when a
 * delete/update races an in-flight state transition. Bounded: 15s x 20.
 */
export const retryWhilePipelineConflict = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(20)]),
  });

/** Structural deep equality over JSON-shaped values (order-insensitive keys). */
export const jsonEquals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every((k) =>
        jsonEquals(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  }
  return false;
};
