import * as glue from "@distilled.cloud/aws/glue";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { diffTags } from "../../Tags.ts";

/** ARN partition — the testing account is on the standard AWS partition. */
const PARTITION = "aws";

/** `arn:aws:glue:{region}:{account}:catalog` */
export const catalogArn = (region: string, accountId: string) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:catalog`;

/** `arn:aws:glue:{region}:{account}:database/{name}` */
export const databaseArn = (
  region: string,
  accountId: string,
  databaseName: string,
) => `arn:${PARTITION}:glue:${region}:${accountId}:database/${databaseName}`;

/** `arn:aws:glue:{region}:{account}:table/{database}/{table}` */
export const tableArn = (
  region: string,
  accountId: string,
  databaseName: string,
  tableName: string,
) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:table/${databaseName}/${tableName}`;

/** `arn:aws:glue:{region}:{account}:crawler/{name}` */
export const crawlerArn = (
  region: string,
  accountId: string,
  crawlerName: string,
) => `arn:${PARTITION}:glue:${region}:${accountId}:crawler/${crawlerName}`;

/** `arn:aws:glue:{region}:{account}:job/{name}` */
export const jobArn = (region: string, accountId: string, jobName: string) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:job/${jobName}`;

/** `arn:aws:glue:{region}:{account}:connection/{name}` */
export const connectionArn = (
  region: string,
  accountId: string,
  connectionName: string,
) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:connection/${connectionName}`;

/**
 * Fetch the observed Glue tags for a resource ARN as a plain record. Glue's
 * `GetTags` returns a `{ Tags: { key: value } }` map (not the array shape most
 * AWS services use). Tolerate a missing/untaggable resource as `{}`.
 */
export const fetchObservedTags = Effect.fn("AWS.Glue.fetchObservedTags")(
  function* (resourceArn: string) {
    const response = yield* glue
      .getTags({ ResourceArn: resourceArn })
      .pipe(Effect.catch(() => Effect.succeed({ Tags: undefined })));
    const tags = response.Tags ?? {};
    return Object.fromEntries(
      Object.entries(tags).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  },
);

/**
 * Sync a Glue resource's tags: diff OBSERVED cloud tags against desired and
 * apply the delta via `TagResource` (map of adds/updates) / `UntagResource`
 * (list of removed keys).
 */
export const syncTags = Effect.fn("AWS.Glue.syncTags")(function* (
  resourceArn: string,
  observed: Record<string, string>,
  desired: Record<string, string>,
) {
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* glue.tagResource({
      ResourceArn: resourceArn,
      TagsToAdd: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* glue.untagResource({
      ResourceArn: resourceArn,
      TagsToRemove: removed,
    });
  }
});

/**
 * Bounded retry through `CrawlerRunningException` — a crawler cannot be
 * updated or deleted while a crawl is in progress. Explicitly typed so the
 * conditional `Retry.Return` type does not leak into the provider's
 * declaration emit and widen `AWS.providers()` for downstream consumers.
 */
export const retryWhileCrawlerRunning = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "CrawlerRunningException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * Bounded retry through `ConcurrentModificationException` — Glue catalog
 * mutations occasionally race under concurrent reconciles. Explicitly typed
 * for the same declaration-emit reason as above.
 */
export const retryWhileConcurrentModification = <
  A,
  E extends { _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConcurrentModificationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

/**
 * Bounded retry through `GlueRoleNotAssumable` — a freshly-created IAM role is
 * not yet assumable by the Glue service (IAM propagation), which surfaces as a
 * message-discriminated `InvalidInputException` (patched into a typed tag).
 * Explicitly typed for the same declaration-emit reason as above.
 */
export const retryWhileRoleNotAssumable = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "GlueRoleNotAssumable",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(12)]),
  });

/**
 * Glue validates crawler S3 targets through a service credential that can lag
 * a newly-created bucket. Retry only the distilled synthetic tag for the
 * observed InvalidAccessKeyId propagation failure.
 */
export const retryWhileCrawlerTargetNotReady = <
  A,
  E extends { _tag: string },
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "GlueS3TargetNotReady",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(10)]),
  });

/** Bounded retry for transient states that prevent crawler deletion. */
export const retryCrawlerDelete = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "CrawlerRunningException" ||
      e._tag === "SchedulerTransitioningException" ||
      e._tag === "OperationTimeoutException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/** Glue free-form parameter/label maps arrive with `undefined` values erased. */
export const cleanMap = (
  map: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
