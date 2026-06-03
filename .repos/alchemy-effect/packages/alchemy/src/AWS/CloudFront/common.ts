import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

// CloudFront KeyValueStore APIs are only available from us-east-1, even when
// the distribution using the store lives elsewhere.
export const KVS_REGION = "us-east-1" as const;

export const extractValue = (v: string | Redacted.Redacted<string>): string =>
  typeof v === "string" ? v : Redacted.value(v);

export const withKvsRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, KVS_REGION as any));

export const withKvsRegionFn =
  <Args extends any[], A, E, R>(
    fn: (...args: Args) => Effect.Effect<A, E, R>,
  ) =>
  (...args: Args) =>
    withKvsRegion(fn(...args));

const isKvsNotReady = (error: unknown) => {
  const tag = (error as { _tag?: string })._tag;
  return tag === "ResourceNotFoundException" || tag === "ConflictException";
};

const cappedKvsRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.both(Schedule.recurs(24)),
  Schedule.map(([duration]) =>
    Duration.isGreaterThan(duration, Duration.seconds(2))
      ? Duration.seconds(2)
      : duration,
  ),
);

export const retryForKvsReadiness = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: isKvsNotReady,
      schedule: cappedKvsRetrySchedule,
    }),
  );

export const getKvsEtag = Effect.fn(function* (store: string) {
  const response = yield* kvs.describeKeyValueStore({ KvsARN: store });
  return response.ETag;
});

export const isKvsPreconditionFailed = (err: kvs.ValidationException) =>
  "Message" in err &&
  typeof err.Message === "string" &&
  err.Message.includes("Pre-Condition failed");
