import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ScheduleEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  invocation_id: Schema.String,
  trigger: Schema.Struct({
    type: Schema.Literal("schedule"),
    id: Schema.String,
    name: Schema.String,
  }),
  data: Schema.Struct({ scheduled_at: Schema.String }),
});
const BucketEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  invocation_id: Schema.String,
  trigger: Schema.Struct({
    type: Schema.Literal("storage_object_created"),
    id: Schema.String,
    name: Schema.String,
  }),
  data: Schema.Struct({
    bucket_name: Schema.String,
    object_key: Schema.String,
  }),
});
/** Validated wire envelope shared by native and Effect handlers. */
export const FunctionTriggerEnvelope = Schema.Union([
  ScheduleEnvelope,
  BucketEnvelope,
]);
export type FunctionTriggerEnvelope = typeof FunctionTriggerEnvelope.Type;

export interface CronEvent {
  /** Stable occurrence ID for application idempotency. */ invocationId: string;
  /** Project-wide trigger identifier. */ triggerId: string;
  /** Trigger name. */ name: string;
  /** UTC scheduled time. */ scheduledAt: string;
}
export interface BucketEvent {
  /** Stable occurrence ID for application idempotency. */ invocationId: string;
  /** Project-wide trigger identifier. */ triggerId: string;
  /** Trigger name. */ name: string;
  /** Exact bucket name. */ bucketName: string;
  /** Exact uploaded key, without path normalization. */ objectKey: string;
}
export class FunctionTriggerEventError extends Data.TaggedError(
  "FunctionTriggerEventError",
)<{ status: 400 | 403 | 405; message: string }> {}

/**
 * Decode a Neon POST envelope and compare the edge-attested invocation header.
 * Trust this header only behind Neon's edge, which strips client-supplied
 * X-Neon-* headers. It is not authentication for an arbitrary local HTTP server.
 */
export const decodeFunctionTriggerEvent = Effect.fn(function* (
  request: Request,
) {
  if (request.method !== "POST")
    return yield* new FunctionTriggerEventError({
      status: 405,
      message: "Trigger delivery requires POST",
    });
  const invocation = request.headers
    .get("x-neon-trigger-invocation-id")
    ?.trim();
  if (!invocation)
    return yield* new FunctionTriggerEventError({
      status: 403,
      message: "Missing Neon trigger attestation",
    });
  const json = yield* Effect.tryPromise({
    try: () => request.json(),
    catch: () =>
      new FunctionTriggerEventError({
        status: 400,
        message: "Invalid trigger JSON",
      }),
  });
  const event = yield* Schema.decodeUnknownEffect(FunctionTriggerEnvelope)(
    json,
  ).pipe(
    Effect.mapError(
      () =>
        new FunctionTriggerEventError({
          status: 400,
          message: "Invalid trigger discriminator or schema version",
        }),
    ),
  );
  if (
    !event.trigger.id ||
    !event.trigger.name ||
    (event.trigger.type === "schedule" &&
      "scheduled_at" in event.data &&
      !event.data.scheduled_at) ||
    ("bucket_name" in event.data &&
      (!event.data.bucket_name || !event.data.object_key))
  )
    return yield* new FunctionTriggerEventError({
      status: 400,
      message: "Empty trigger identity or event data",
    });
  if (event.invocation_id !== invocation || event.invocation_id.length === 0)
    return yield* new FunctionTriggerEventError({
      status: 403,
      message: "Trigger invocation ID mismatch",
    });
  return event;
});
