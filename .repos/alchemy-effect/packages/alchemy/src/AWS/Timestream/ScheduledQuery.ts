import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { withQueryEndpoint } from "./internal.ts";

export type ScheduledQueryState = TSQ.ScheduledQueryState;

export interface ScheduledQueryErrorReportS3 {
  /**
   * Name of the S3 bucket where error reports for failed runs are written.
   */
  bucketName: string;
  /**
   * Object key prefix for error report objects.
   */
  objectKeyPrefix?: string;
  /**
   * Server-side encryption for error report objects.
   * @default "SSE_S3"
   */
  encryptionOption?: TSQ.S3EncryptionOption;
}

export interface ScheduledQueryProps {
  /**
   * Name of the scheduled query. Must be unique within the account and
   * region.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The SQL the scheduled query runs on each invocation.
   */
  queryString: string;
  /**
   * When to run the query — a cron (`cron(0 12 * * ? *)`) or rate
   * (`rate(1 hour)`) expression.
   */
  scheduleExpression: string;
  /**
   * ARN of the SNS topic Timestream notifies after each run.
   */
  notificationTopicArn: string;
  /**
   * ARN of the IAM role Timestream assumes to run the query, write results,
   * publish notifications, and write error reports.
   */
  executionRoleArn: string;
  /**
   * Where results are written (a Timestream table with measure/dimension
   * mappings). Omit for queries whose results are not materialized.
   */
  targetConfiguration?: TSQ.TargetConfiguration;
  /**
   * S3 location where error reports for failed runs are written.
   */
  errorReportS3: ScheduledQueryErrorReportS3;
  /**
   * The KMS key used to encrypt the scheduled query resource at rest. When
   * omitted, Timestream uses an AWS-owned key.
   */
  kmsKeyId?: string;
  /**
   * Whether the schedule is active.
   * @default "ENABLED"
   */
  state?: ScheduledQueryState;
  /**
   * Tags to associate with the scheduled query.
   */
  tags?: Record<string, string>;
}

export interface ScheduledQuery extends Resource<
  "AWS.Timestream.ScheduledQuery",
  ScheduledQueryProps,
  {
    /**
     * ARN of the scheduled query.
     */
    scheduledQueryArn: string;
    /**
     * The scheduled query's physical name.
     */
    name: string;
    /**
     * Whether the schedule is currently active.
     */
    state: ScheduledQueryState;
    /**
     * Current tags reported for the scheduled query.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Timestream for LiveAnalytics scheduled query — a SQL query
 * Timestream runs on a cron/rate schedule, materializing results into a
 * target table and notifying an SNS topic after each run.
 *
 * Only the `state` (ENABLED/DISABLED) is mutable in place; changing the
 * query, schedule, notification topic, role, target, error report location,
 * or KMS key replaces the scheduled query. Tags sync in place.
 *
 * :::note
 * Timestream for LiveAnalytics is closed to new AWS customers. Accounts that
 * were not already onboarded receive `TimestreamNotOnboarded` (a specialized
 * `AccessDenied`) on every operation.
 * :::
 * @resource
 * @section Creating Scheduled Queries
 * @example Hourly Rollup
 * ```typescript
 * import * as Timestream from "alchemy/AWS/Timestream";
 *
 * const rollup = yield* Timestream.ScheduledQuery("HourlyRollup", {
 *   queryString: `SELECT host, AVG(measure_value::double) AS avg_cpu
 *                 FROM "metrics"."cpu"
 *                 WHERE time > ago(1h) GROUP BY host`,
 *   scheduleExpression: "rate(1 hour)",
 *   notificationTopicArn: topic.topicArn,
 *   executionRoleArn: role.roleArn,
 *   errorReportS3: { bucketName: bucket.bucketName },
 *   targetConfiguration: {
 *     TimestreamConfiguration: {
 *       DatabaseName: database.databaseName,
 *       TableName: rollupTable.tableName,
 *       TimeColumn: "time",
 *       DimensionMappings: [{ Name: "host", DimensionValueType: "VARCHAR" }],
 *       MultiMeasureMappings: {
 *         TargetMultiMeasureName: "cpu_rollup",
 *         MultiMeasureAttributeMappings: [
 *           { SourceColumn: "avg_cpu", MeasureValueType: "DOUBLE" },
 *         ],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @example Pausing a Schedule
 * ```typescript
 * const rollup = yield* Timestream.ScheduledQuery("HourlyRollup", {
 *   // ... unchanged configuration ...
 *   state: "DISABLED",
 * });
 * ```
 */
export const ScheduledQuery = Resource<ScheduledQuery>(
  "AWS.Timestream.ScheduledQuery",
);

const createScheduledQueryName = (
  id: string,
  props: { name?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.name) {
      return props.name;
    }
    return yield* createPhysicalName({ id, maxLength: 64 });
  });

const toTagRecord = (
  tags: Array<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

const readScheduledQuery = Effect.fn(function* (scheduledQueryArn: string) {
  const response = yield* withQueryEndpoint(
    TSQ.describeScheduledQuery({ ScheduledQueryArn: scheduledQueryArn }),
  ).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
  if (!response?.ScheduledQuery) {
    return undefined;
  }
  const scheduledQuery = response.ScheduledQuery;
  const tags = yield* withQueryEndpoint(
    TSQ.listTagsForResource.items({ ResourceARN: scheduledQuery.Arn }).pipe(
      EffectStream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    ),
  ).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
  if (!tags) {
    return undefined;
  }
  return {
    scheduledQueryArn: scheduledQuery.Arn,
    name: scheduledQuery.Name,
    state: scheduledQuery.State,
    tags: toTagRecord(tags),
  } satisfies ScheduledQuery["Attributes"];
});

const findScheduledQueryByName = Effect.fn(function* (name: string) {
  const match = yield* withQueryEndpoint(
    TSQ.listScheduledQueries.pages({}).pipe(
      EffectStream.map((page) => page.ScheduledQueries ?? []),
      EffectStream.flattenIterable,
      EffectStream.filter((summary) => summary.Name === name),
      EffectStream.runHead,
    ),
  ).pipe(Effect.map(Option.getOrUndefined));
  if (!match) return undefined;
  return yield* readScheduledQuery(match.Arn);
});

export const ScheduledQueryProvider = () =>
  Provider.effect(
    ScheduledQuery,
    Effect.gen(function* () {
      return {
        stables: ["scheduledQueryArn", "name"],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* withQueryEndpoint(
              TSQ.listScheduledQueries.pages({}).pipe(EffectStream.runCollect),
            ).pipe(
              Effect.map((chunk) =>
                Array.from(chunk).flatMap(
                  (page) => page.ScheduledQueries ?? [],
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              summaries,
              (summary) => readScheduledQuery(summary.Arn),
              { concurrency: 5 },
            );
            return hydrated.filter(
              (attrs): attrs is ScheduledQuery["Attributes"] =>
                attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const state = output?.scheduledQueryArn
            ? yield* readScheduledQuery(output.scheduledQueryArn)
            : yield* findScheduledQueryByName(
                yield* createScheduledQueryName(id, olds ?? {}),
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news) || olds === undefined) return;
          const oldName = yield* createScheduledQueryName(id, olds);
          const newName = yield* createScheduledQueryName(id, news);
          // Only State is mutable via UpdateScheduledQuery — every other
          // aspect requires a replacement.
          const changed = (a: unknown, b: unknown) =>
            JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
          if (
            oldName !== newName ||
            olds.queryString !== news.queryString ||
            olds.scheduleExpression !== news.scheduleExpression ||
            olds.notificationTopicArn !== news.notificationTopicArn ||
            olds.executionRoleArn !== news.executionRoleArn ||
            olds.kmsKeyId !== news.kmsKeyId ||
            changed(olds.targetConfiguration, news.targetConfiguration) ||
            changed(olds.errorReportS3, news.errorReportS3)
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news) {
            return yield* Effect.fail(
              new Error("Timestream ScheduledQuery requires props"),
            );
          }
          const name =
            output?.name ?? (yield* createScheduledQueryName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached ARN; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let state = output?.scheduledQueryArn
            ? yield* readScheduledQuery(output.scheduledQueryArn)
            : yield* findScheduledQueryByName(name);

          // Ensure — create if missing; tolerate a ConflictException race.
          if (state === undefined) {
            yield* withQueryEndpoint(
              TSQ.createScheduledQuery({
                Name: name,
                QueryString: news.queryString,
                ScheduleConfiguration: {
                  ScheduleExpression: news.scheduleExpression,
                },
                NotificationConfiguration: {
                  SnsConfiguration: { TopicArn: news.notificationTopicArn },
                },
                ScheduledQueryExecutionRoleArn: news.executionRoleArn,
                TargetConfiguration: news.targetConfiguration,
                ErrorReportConfiguration: {
                  S3Configuration: {
                    BucketName: news.errorReportS3.bucketName,
                    ObjectKeyPrefix: news.errorReportS3.objectKeyPrefix,
                    EncryptionOption: news.errorReportS3.encryptionOption,
                  },
                },
                KmsKeyId: news.kmsKeyId,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            ).pipe(Effect.catchTag("ConflictException", () => Effect.void));
            yield* session.note(`Creating scheduled query ${name}...`);
            state = yield* findScheduledQueryByName(name);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created scheduled query ${name}`),
              );
            }
          }

          // Sync state — the only in-place mutable aspect.
          const desiredState = news.state ?? "ENABLED";
          if (state.state !== desiredState) {
            yield* withQueryEndpoint(
              TSQ.updateScheduledQuery({
                ScheduledQueryArn: state.scheduledQueryArn,
                State: desiredState,
              }),
            );
            yield* session.note(
              `Updated scheduled query ${name} state to ${desiredState}`,
            );
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* withQueryEndpoint(
              TSQ.untagResource({
                ResourceARN: state.scheduledQueryArn,
                TagKeys: removed,
              }),
            );
          }
          if (upsert.length > 0) {
            yield* withQueryEndpoint(
              TSQ.tagResource({
                ResourceARN: state.scheduledQueryArn,
                Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
              }),
            );
          }

          yield* session.note(state.scheduledQueryArn);

          const final = yield* readScheduledQuery(state.scheduledQueryArn);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled scheduled query ${name}`),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* withQueryEndpoint(
            TSQ.deleteScheduledQuery({
              ScheduledQueryArn: output.scheduledQueryArn,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );
