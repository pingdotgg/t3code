import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as glue from "@distilled.cloud/aws/glue";
import * as lf from "@distilled.cloud/aws/lakeformation";
import { diffTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/** ARN partition — the testing account is on the standard AWS partition. */
const PARTITION = "aws";

/** `arn:aws:glue:{region}:{account}:catalog` */
export const catalogArn = (region: string, accountId: string) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:catalog`;

/** `arn:aws:glue:{region}:{account}:database/{name}` */
export const databaseArn = (region: string, accountId: string, databaseName: string) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:database/${databaseName}`;

/** `arn:aws:glue:{region}:{account}:table/{database}/{table}` */
export const tableArn = (
  region: string,
  accountId: string,
  databaseName: string,
  tableName: string,
) => `arn:${PARTITION}:glue:${region}:${accountId}:table/${databaseName}/${tableName}`;

/** `arn:aws:glue:{region}:{account}:crawler/{name}` */
export const crawlerArn = (region: string, accountId: string, crawlerName: string) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:crawler/${crawlerName}`;

/** `arn:aws:glue:{region}:{account}:job/{name}` */
export const jobArn = (region: string, accountId: string, jobName: string) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:job/${jobName}`;

/** `arn:aws:glue:{region}:{account}:connection/{name}` */
export const connectionArn = (region: string, accountId: string, connectionName: string) =>
  `arn:${PARTITION}:glue:${region}:${accountId}:connection/${connectionName}`;

/**
 * Fetch the observed Glue tags for a resource ARN as a plain record. Glue's
 * `GetTags` returns a `{ Tags: { key: value } }` map (not the array shape most
 * AWS services use). Tolerate a missing/untaggable resource as `{}`.
 */
export const fetchObservedTags = Effect.fn("AWS.Glue.fetchObservedTags")(function* (
  resourceArn: string,
) {
  const response = yield* glue
    .getTags({ ResourceArn: resourceArn })
    .pipe(Effect.orElseSucceed(() => ({ Tags: undefined })));
  const tags = response.Tags ?? {};
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

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
export const retryWhileConcurrentModification = <A, E extends { _tag: string }, R>(
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
export const retryWhileCrawlerTargetNotReady = <A, E extends { _tag: string }, R>(
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
    Object.entries(map ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/**
 * Glue writes crawler and job-run logs into SHARED, service-managed log
 * groups (`/aws-glue/crawlers`, `/aws-glue/python-jobs/output`, …) that it
 * auto-creates on first use. The groups belong to the Glue service, not to
 * any one crawler/job, so a provider must never delete them — it reaps only
 * the streams it owns (named after the crawler, or prefixed by a run id).
 *
 * Best-effort and bounded: log cleanup is auxiliary to the already-completed
 * resource delete, so a missing group/stream is success and a slow API only
 * logs a warning.
 */
export const reapGlueLogStreams = (
  logGroupNames: readonly string[],
  streamPrefixes: readonly string[],
  options: { exact?: boolean } = {},
) =>
  Effect.forEach(
    logGroupNames.flatMap((logGroupName) =>
      streamPrefixes.map((prefix) => ({ logGroupName, prefix })),
    ),
    ({ logGroupName, prefix }) =>
      logs.describeLogStreams.items({ logGroupName, logStreamNamePrefix: prefix }).pipe(
        Stream.mapEffect(
          (stream) =>
            stream.logStreamName === undefined ||
            (options.exact === true && stream.logStreamName !== prefix)
              ? Effect.void
              : logs.deleteLogStream({ logGroupName, logStreamName: stream.logStreamName }).pipe(
                  Effect.retry({
                    while: (e) =>
                      e._tag === "OperationAbortedException" ||
                      e._tag === "ServiceUnavailableException",
                    schedule: Schedule.exponential("250 millis"),
                    times: 6,
                  }),
                  Effect.catchTag("ResourceNotFoundException", () => Effect.void),
                ),
          { concurrency: 5 },
        ),
        Stream.runDrain,
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () =>
            Effect.logWarning(`Timed out reaping Glue log streams ${logGroupName}/${prefix}*`),
        }),
      ),
    { concurrency: 5, discard: true },
  );

/**
 * Delete a Glue database, tolerating one that is already gone.
 *
 * A database registered under Lake Formation (e.g. one a DataZone
 * environment provisioned) only grants DROP to the principals LF lists — IAM
 * admin rights are not enough. A Lake Formation admin may re-open it to IAM
 * access control, after which the drop succeeds. A caller that is not an LF
 * admin gets the original denial back.
 */
export const deleteGlueDatabase = Effect.fn("AWS.Glue.deleteGlueDatabase")(function* (
  name: string,
  catalogId: string | undefined,
) {
  const drop = glue.deleteDatabase({ Name: name, CatalogId: catalogId }).pipe(
    retryWhileConcurrentModification,
    Effect.catchTag("EntityNotFoundException", () => Effect.void),
  );
  yield* drop.pipe(
    Effect.catchTag("InsufficientLakeFormationPermissions", (error) =>
      lf
        .grantPermissions({
          CatalogId: catalogId,
          Principal: { DataLakePrincipalIdentifier: "IAM_ALLOWED_PRINCIPALS" },
          Resource: { Database: { CatalogId: catalogId, Name: name } },
          Permissions: ["ALL"],
        })
        .pipe(
          retryWhileConcurrentModification,
          Effect.catchTags({
            EntityNotFoundException: () => Effect.void,
            AccessDeniedException: () => Effect.fail(error),
          }),
          Effect.andThen(drop),
        ),
    ),
  );
});
