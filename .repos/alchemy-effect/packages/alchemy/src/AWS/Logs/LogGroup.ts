import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type LogGroupName = string;
export type LogGroupArn =
  `arn:aws:logs:${RegionID}:${AccountID}:log-group:${LogGroupName}`;

export interface LogGroupProps {
  /**
   * Name of the log group. If omitted, a unique name is generated.
   */
  logGroupName?: string;
  /**
   * Retention in days. If omitted, CloudWatch keeps logs indefinitely.
   */
  retentionInDays?: number;
  /**
   * Optional KMS key identifier used to encrypt the log group.
   */
  kmsKeyId?: string;
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
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Logs log group.
 *
 * @section Creating Log Groups
 * @example ECS Task Log Group
 * ```typescript
 * const logs = yield* LogGroup("TaskLogs", {
 *   retentionInDays: 7,
 * });
 * ```
 */
export const LogGroup = Resource<LogGroup>("AWS.Logs.LogGroup");

export const LogGroupProvider = () =>
  Provider.effect(
    LogGroup,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      const toLogGroupName = (
        id: string,
        props: { logGroupName?: string } = {},
      ) =>
        props.logGroupName
          ? Effect.succeed(props.logGroupName)
          : createPhysicalName({ id, maxLength: 512 });

      return {
        stables: ["logGroupArn", "logGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toLogGroupName(id, olds ?? {})) !==
            (yield* toLogGroupName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const logGroupName =
            output?.logGroupName ?? (yield* toLogGroupName(id, olds ?? {}));
          const described = yield* logs.describeLogGroups({
            logGroupNamePrefix: logGroupName,
            limit: 1,
          });
          const match = (described.logGroups ?? []).find(
            (group) => group.logGroupName === logGroupName,
          );
          if (!match?.arn) {
            return undefined;
          }
          return {
            logGroupName,
            logGroupArn: match.arn as LogGroupArn,
            retentionInDays: match.retentionInDays,
            kmsKeyId: match.kmsKeyId,
            tags: output?.tags ?? {},
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const logGroupName =
            output?.logGroupName ?? (yield* toLogGroupName(id, news));
          const arn = (output?.logGroupArn ??
            `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`) as LogGroupArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live state. `describeLogGroups` returns
          // retention/kms info so we can diff against desired without
          // trusting `olds` or `output`.
          const described = yield* logs.describeLogGroups({
            logGroupNamePrefix: logGroupName,
            limit: 1,
          });
          let observed = (described.logGroups ?? []).find(
            (group) => group.logGroupName === logGroupName,
          );

          // Ensure — create if missing. `createLogGroup` accepts tags and
          // kmsKeyId on first create; tolerate `ResourceAlreadyExistsException`
          // (race with peer reconciler) and re-read.
          if (!observed?.arn) {
            yield* logs
              .createLogGroup({
                logGroupName,
                kmsKeyId: news.kmsKeyId,
                tags: desiredTags,
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            const reread = yield* logs.describeLogGroups({
              logGroupNamePrefix: logGroupName,
              limit: 1,
            });
            observed = (reread.logGroups ?? []).find(
              (group) => group.logGroupName === logGroupName,
            );
          }

          // Sync retention — observed ↔ desired.
          const observedRetention = observed?.retentionInDays;
          if (news.retentionInDays !== observedRetention) {
            if (news.retentionInDays === undefined) {
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
                retentionInDays: news.retentionInDays,
              });
            }
          }

          // Sync tags — list observed tags then diff against desired so
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
            retentionInDays: news.retentionInDays,
            kmsKeyId: news.kmsKeyId,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteLogGroup({
              logGroupName: output.logGroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
