import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface LogStreamProps {
  /**
   * Name of the log group the stream belongs to.
   * Changing this value replaces the log stream.
   */
  logGroupName: string;
  /**
   * Name of the log stream. If omitted, a unique name is generated.
   * Changing this value replaces the log stream.
   */
  logStreamName?: string;
}

export interface LogStream extends Resource<
  "AWS.Logs.LogStream",
  LogStreamProps,
  {
    logStreamName: string;
    logGroupName: string;
    logStreamArn?: string;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Logs log stream — a sequence of log events within a log group.
 *
 * Most log streams are created automatically by the emitting service (Lambda
 * creates its own streams under `/aws/lambda/...`); declare one explicitly
 * only when writing custom log events via `putLogEvents`.
 * @resource
 * @section Creating Log Streams
 * @example Custom Audit Stream
 * ```typescript
 * const stream = yield* LogStream("AuditStream", {
 *   logGroupName: logGroup.logGroupName,
 * });
 * ```
 */
export const LogStream = Resource<LogStream>("AWS.Logs.LogStream");

export const LogStreamProvider = () =>
  Provider.effect(
    LogStream,
    Effect.gen(function* () {
      const toLogStreamName = (
        id: string,
        props: { logStreamName?: string } = {},
      ) =>
        props.logStreamName
          ? Effect.succeed(props.logStreamName)
          : createPhysicalName({ id, maxLength: 512 });

      const observe = Effect.fn(function* (
        logGroupName: string,
        logStreamName: string,
      ) {
        const described = yield* logs
          .describeLogStreams({
            logGroupName,
            logStreamNamePrefix: logStreamName,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ logStreams: [] }),
            ),
          );
        return (described.logStreams ?? []).find(
          (stream) => stream.logStreamName === logStreamName,
        );
      });

      return {
        stables: ["logStreamName", "logGroupName", "logStreamArn"],
        // No account-wide stream list — fan out over every log group.
        list: () =>
          Effect.gen(function* () {
            const groups = yield* logs.describeLogGroups.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk)
                  .flatMap((page) => page.logGroups ?? [])
                  .map((group) => group.logGroupName)
                  .filter((name): name is string => name != null),
              ),
            );
            const perGroup = yield* Effect.forEach(
              groups,
              (logGroupName) =>
                logs.describeLogStreams.pages({ logGroupName }).pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk)
                      .flatMap((page) => page.logStreams ?? [])
                      .filter(
                        (
                          stream,
                        ): stream is logs.LogStream & {
                          logStreamName: string;
                        } => stream.logStreamName != null,
                      )
                      .map((stream) => ({
                        logStreamName: stream.logStreamName,
                        logGroupName,
                        logStreamArn: stream.arn,
                      })),
                  ),
                  // group deleted between list and describe — skip
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([]),
                  ),
                ),
              { concurrency: 10 },
            );
            return perGroup.flat();
          }),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (olds.logGroupName !== news.logGroupName) {
            return { action: "replace" } as const;
          }
          if (
            (yield* toLogStreamName(id, olds)) !==
            (yield* toLogStreamName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const logGroupName = output?.logGroupName ?? olds?.logGroupName;
          if (logGroupName === undefined) return undefined;
          const logStreamName =
            output?.logStreamName ?? (yield* toLogStreamName(id, olds ?? {}));
          const observed = yield* observe(logGroupName, logStreamName);
          if (!observed) return undefined;
          return {
            logStreamName,
            logGroupName,
            logStreamArn: observed.arn,
          };
        }),
        // Existence-only resource: observe → if missing, create. Nothing on a
        // log stream is mutable.
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const logGroupName = news.logGroupName;
          const logStreamName =
            output?.logStreamName ?? (yield* toLogStreamName(id, news));

          let observed = yield* observe(logGroupName, logStreamName);
          if (!observed) {
            yield* logs
              .createLogStream({ logGroupName, logStreamName })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            observed = yield* observe(logGroupName, logStreamName);
          }

          yield* session.note(`${logGroupName}:${logStreamName}`);

          return {
            logStreamName,
            logGroupName,
            logStreamArn: observed?.arn,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteLogStream({
              logGroupName: output.logGroupName,
              logStreamName: output.logStreamName,
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
            observe(output.logGroupName, output.logStreamName),
            {
              schedule: Schedule.fixed("250 millis"),
              until: (stream) => stream === undefined,
              times: 20,
            },
          );
          if (remaining !== undefined) {
            yield* Effect.die(
              new Error(
                `CloudWatch log stream ${output.logGroupName}:${output.logStreamName} remained observable after delete`,
              ),
            );
          }
        }),
      };
    }),
  );
