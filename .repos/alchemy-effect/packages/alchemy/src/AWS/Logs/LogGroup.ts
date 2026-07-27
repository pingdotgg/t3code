import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type LogGroupName = string;
export type LogGroupArn =
  `arn:aws:logs:${RegionID}:${AccountID}:log-group:${LogGroupName}`;
export type LogGroupClass = logs.LogGroupClass;

export interface LogGroupProps {
  /**
   * Name of the log group. If omitted, a unique name is generated.
   */
  logGroupName?: string;
  /**
   * How long CloudWatch retains log events. If omitted, logs are kept
   * indefinitely. Accepts any `Duration.Input` (e.g. `"7 days"`,
   * `Duration.days(7)`; a bare number is milliseconds); the wire unit is
   * whole days (`retentionInDays`) and must resolve to one of the retention
   * values CloudWatch accepts (1, 3, 5, 7, 14, 30, ...).
   */
  retention?: Duration.Input;
  /**
   * Optional KMS key identifier used to encrypt the log group.
   */
  kmsKeyId?: string;
  /**
   * Log class for the log group. Changing this value replaces the log group.
   * @default "STANDARD"
   */
  logGroupClass?: LogGroupClass;
  /**
   * Whether deletion protection is enabled for the log group.
   * @default false
   */
  deletionProtectionEnabled?: boolean;
  /**
   * User-defined tags to apply to the log group.
   */
  tags?: Record<string, string>;
}

export interface LogGroup extends Resource<
  "AWS.Logs.LogGroup",
  LogGroupProps,
  {
    logGroupName: LogGroupName;
    logGroupArn: LogGroupArn;
    retentionInDays?: number;
    kmsKeyId?: string;
    logGroupClass: LogGroupClass;
    deletionProtectionEnabled: boolean;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Logs log group — the container for log streams and the unit
 * that retention, encryption, metric filters, and subscriptions attach to.
 * @resource
 * @section Creating Log Groups
 * @example ECS Task Log Group
 * ```typescript
 * const logs = yield* LogGroup("TaskLogs", {
 *   retention: "7 days",
 * });
 * ```
 *
 * @example Encrypted Log Group with Deletion Protection
 * ```typescript
 * const key = yield* AWS.KMS.Key("LogsKey");
 * const logs = yield* LogGroup("AuditLogs", {
 *   retention: "30 days",
 *   kmsKeyId: key.keyArn,
 *   deletionProtectionEnabled: true,
 * });
 * ```
 *
 * @section Writing Custom Log Events
 * Declare a `LogStream` and use the `PutLogEvents` binding inside a Lambda
 * function (or the batching `LogEventSink` for high-volume streams).
 *
 * @example Custom Audit Trail from a Lambda Function
 * ```typescript
 * // init
 * const logGroup = yield* AWS.Logs.LogGroup("AuditLogs", {
 *   retention: "30 days",
 * });
 * const stream = yield* AWS.Logs.LogStream("AuditStream", {
 *   logGroupName: logGroup.logGroupName,
 *   logStreamName: "audit",
 * });
 * const putLogEvents = yield* AWS.Logs.PutLogEvents(logGroup);
 *
 * // runtime
 * yield* putLogEvents({
 *   logStreamName: "audit",
 *   logEvents: [{ timestamp, message: "user.login id=123" }],
 * });
 * ```
 *
 * @section Consuming Log Events
 * @example React to Error Logs
 * ```typescript
 * // Subscribe a Lambda handler to matching events (creates the
 * // subscription filter + invoke permission automatically).
 * yield* AWS.Logs.consumeLogEvents(
 *   logGroup,
 *   { filterPattern: "?ERROR ?Error" },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`${event.logStream}: ${event.message}`),
 *     ),
 * );
 * ```
 *
 * @section Metrics
 * @example Count Errors with a Metric Filter
 * ```typescript
 * yield* AWS.Logs.MetricFilter("ErrorCount", {
 *   logGroupName: logGroup.logGroupName,
 *   filterPattern: '"ERROR"',
 *   metricTransformations: [{
 *     metricName: "ErrorCount",
 *     metricNamespace: "MyApp",
 *     metricValue: "1",
 *   }],
 * });
 * ```
 */
export const LogGroup = Resource<LogGroup>("AWS.Logs.LogGroup");

export const LogGroupProvider = () =>
  Provider.effect(
    LogGroup,
    Effect.gen(function* () {
      const toLogGroupName = (
        id: string,
        props: { logGroupName?: string } = {},
      ) =>
        props.logGroupName
          ? Effect.succeed(props.logGroupName)
          : createPhysicalName({ id, maxLength: 512 });
      const toLogGroupClass = (
        props: { logGroupClass?: LogGroupClass } = {},
      ): LogGroupClass => props.logGroupClass ?? "STANDARD";
      // describeLogGroups returns ARNs with a trailing `:*` while reconcile
      // constructs them without — normalize so refresh/adoption never reports
      // phantom drift and interpolated IAM ARNs (`${arn}:*`) stay correct.
      const normalizeLogGroupArn = (arn: string): LogGroupArn =>
        (arn.endsWith(":*") ? arn.slice(0, -2) : arn) as LogGroupArn;
      const observe = Effect.fn(function* (logGroupName: string) {
        return yield* logs.describeLogGroups
          .items({ logGroupNamePrefix: logGroupName })
          .pipe(
            Stream.filter((group) => group.logGroupName === logGroupName),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
      });

      return {
        stables: ["logGroupArn", "logGroupName"],
        // AWS account/region collection: paginate `describeLogGroups`
        // exhaustively, then hydrate each group's tags via
        // `listTagsForResource` (bounded concurrency) into the exact `read`
        // Attributes shape.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const groups = yield* logs.describeLogGroups.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.logGroups ?? []),
              ),
            );

            return yield* Effect.forEach(
              groups.filter(
                (
                  group,
                ): group is logs.LogGroup & {
                  logGroupName: string;
                  arn: string;
                } => group.logGroupName != null && group.arn != null,
              ),
              (group) =>
                Effect.gen(function* () {
                  const tagArn =
                    `arn:aws:logs:${region}:${accountId}:log-group:${group.logGroupName}` as LogGroupArn;
                  const tags = yield* logs
                    .listTagsForResource({ resourceArn: tagArn })
                    .pipe(
                      Effect.map(
                        (r): Record<string, string> =>
                          Object.fromEntries(
                            Object.entries(r.tags ?? {}).filter(
                              (entry): entry is [string, string] =>
                                typeof entry[1] === "string",
                            ),
                          ),
                      ),
                      Effect.catchTag("ResourceNotFoundException", () =>
                        Effect.succeed({} as Record<string, string>),
                      ),
                    );
                  return {
                    logGroupName: group.logGroupName,
                    logGroupArn: normalizeLogGroupArn(group.arn),
                    retentionInDays: group.retentionInDays,
                    kmsKeyId: group.kmsKeyId,
                    logGroupClass: group.logGroupClass ?? "STANDARD",
                    deletionProtectionEnabled:
                      group.deletionProtectionEnabled ?? false,
                    tags,
                  };
                }),
              { concurrency: 10 },
            );
          }),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toLogGroupName(id, olds ?? {})) !==
            (yield* toLogGroupName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          if (toLogGroupClass(olds ?? {}) !== toLogGroupClass(news ?? {})) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const logGroupName =
            output?.logGroupName ?? (yield* toLogGroupName(id, olds ?? {}));
          const match = yield* observe(logGroupName);
          if (!match?.arn) {
            return undefined;
          }
          return {
            logGroupName,
            logGroupArn: normalizeLogGroupArn(match.arn),
            retentionInDays: match.retentionInDays,
            kmsKeyId: match.kmsKeyId,
            logGroupClass: match.logGroupClass ?? "STANDARD",
            deletionProtectionEnabled: match.deletionProtectionEnabled ?? false,
            tags: output?.tags ?? {},
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const logGroupName =
            output?.logGroupName ?? (yield* toLogGroupName(id, news));
          const arn = (output?.logGroupArn ??
            `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`) as LogGroupArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          // Wire unit is whole days (retentionInDays).
          const desiredRetention = toWireDays(news.retention);

          // Observe - fetch live state. `describeLogGroups` returns
          // retention/kms info so we can diff against desired without
          // trusting `olds` or `output`.
          let observed = yield* observe(logGroupName);

          // Ensure - create if missing. `createLogGroup` accepts tags and
          // kmsKeyId on first create; tolerate `ResourceAlreadyExistsException`
          // (race with peer reconciler) and re-read.
          if (!observed?.arn) {
            yield* logs
              .createLogGroup({
                logGroupName,
                kmsKeyId: news.kmsKeyId,
                tags: desiredTags,
                logGroupClass: news.logGroupClass,
                deletionProtectionEnabled: news.deletionProtectionEnabled,
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            observed = yield* observe(logGroupName);
          }

          // Sync KMS key - create accepts kmsKeyId, but updates require the
          // association API. Disassociating only affects newly ingested events.
          const observedKmsKeyId = observed?.kmsKeyId;
          if (news.kmsKeyId !== observedKmsKeyId) {
            if (news.kmsKeyId === undefined) {
              if (observedKmsKeyId !== undefined) {
                yield* logs
                  .disassociateKmsKey({ logGroupName })
                  .pipe(
                    Effect.catchTag(
                      "ResourceNotFoundException",
                      () => Effect.void,
                    ),
                  );
              }
            } else {
              yield* logs.associateKmsKey({
                logGroupName,
                kmsKeyId: news.kmsKeyId,
              });
            }
          }

          // Sync deletion protection - destroy disables it before deletion, but
          // normal deploys should still converge the live flag to desired state.
          const desiredDeletionProtection =
            news.deletionProtectionEnabled ?? false;
          const observedDeletionProtection =
            observed?.deletionProtectionEnabled ?? false;
          if (desiredDeletionProtection !== observedDeletionProtection) {
            yield* logs.putLogGroupDeletionProtection({
              logGroupIdentifier: logGroupName,
              deletionProtectionEnabled: desiredDeletionProtection,
            });
          }

          // Sync retention - observed to desired.
          const observedRetention = observed?.retentionInDays;
          if (desiredRetention !== observedRetention) {
            if (desiredRetention === undefined) {
              yield* logs
                .deleteRetentionPolicy({
                  logGroupName,
                })
                .pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                );
            } else {
              yield* logs.putRetentionPolicy({
                logGroupName,
                retentionInDays: desiredRetention,
              });
            }
          }

          // Sync tags - list observed tags then diff against desired so
          // adoption rewrites ownership tags correctly.
          const observedTags = yield* logs
            .listTagsForResource({ resourceArn: arn })
            .pipe(
              Effect.map(
                (r): Record<string, string> =>
                  Object.fromEntries(
                    Object.entries(r.tags ?? {}).filter(
                      (entry): entry is [string, string] =>
                        typeof entry[1] === "string",
                    ),
                  ),
              ),
              Effect.catch(() => Effect.succeed({} as Record<string, string>)),
            );
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* logs.tagResource({
              resourceArn: arn,
              tags: Object.fromEntries(
                upsert.map((tag) => [tag.Key, tag.Value]),
              ),
            });
          }
          if (removed.length > 0) {
            yield* logs.untagResource({
              resourceArn: arn,
              tagKeys: removed,
            });
          }

          yield* session.note(arn);

          return {
            logGroupName,
            logGroupArn: arn,
            retentionInDays: desiredRetention,
            kmsKeyId: news.kmsKeyId,
            logGroupClass: observed?.logGroupClass ?? toLogGroupClass(news),
            deletionProtectionEnabled: desiredDeletionProtection,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .putLogGroupDeletionProtection({
              logGroupIdentifier: output.logGroupName,
              deletionProtectionEnabled: false,
            })
            .pipe(
              Effect.retry({
                while: (error) =>
                  error._tag === "OperationAbortedException" ||
                  error._tag === "ServiceUnavailableException",
                schedule: Schedule.exponential(100),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          yield* logs
            .deleteLogGroup({
              logGroupName: output.logGroupName,
            })
            .pipe(
              Effect.retry({
                while: (error) =>
                  error._tag === "OperationAbortedException" ||
                  error._tag === "ServiceUnavailableException",
                schedule: Schedule.exponential(100),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          const remaining = yield* Effect.repeat(
            logs.describeLogGroups
              .items({ logGroupNamePrefix: output.logGroupName })
              .pipe(
                Stream.filter(
                  (group) => group.logGroupName === output.logGroupName,
                ),
                Stream.runHead,
                Effect.map(Option.isSome),
              ),
            {
              schedule: Schedule.fixed("250 millis"),
              until: (present) => !present,
              times: 20,
            },
          );
          if (remaining) {
            yield* Effect.die(
              new Error(
                `CloudWatch log group ${output.logGroupName} remained observable after delete`,
              ),
            );
          }
        }),
      };
    }),
  );
