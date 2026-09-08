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
  // The distilled Region service value is `Effect<RegionName>`, not a raw
  // string — providing a bare string makes the client `yield*` a string and
  // crash. Wrap in Effect.succeed (same as ACM/ECRPublic/WAFv2/GlobalAccelerator).
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed(KVS_REGION)));

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

/**
 * Bounded KVS retry: exponential backoff with the per-attempt delay capped
 * at 2s and at most 24 recurrences (~45s worst case). NEVER use a bare
 * `Schedule.max([Schedule.exponential(...), Schedule.recurs(n)])` for KVS
 * retries — `recurs` bounds the COUNT, not the TIME, and an uncapped
 * exponential makes the tail attempts wait minutes-to-hours (24 attempts
 * at 100ms doubling total ~19 days), which reads as a silent hang.
 */
export const cappedKvsRetrySchedule = Schedule.max([
  Schedule.exponential("100 millis"),
  Schedule.recurs(24),
]).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(
      Duration.isGreaterThan(duration, Duration.seconds(2))
        ? Duration.seconds(2)
        : duration,
    ),
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
  typeof err.message === "string" &&
  err.message.includes("Pre-Condition failed");
