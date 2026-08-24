import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ApplicationCloudWatchLoggingOptionProps {
  /**
   * Name of the Managed Service for Apache Flink application to attach the
   * logging option to. Changing the application replaces the option.
   */
  applicationName: string;
  /**
   * ARN of the CloudWatch Logs log stream that receives application
   * messages. Changing the log stream replaces the option.
   */
  logStreamArn: string;
}

export interface ApplicationCloudWatchLoggingOption extends Resource<
  "AWS.KinesisAnalyticsV2.ApplicationCloudWatchLoggingOption",
  ApplicationCloudWatchLoggingOptionProps,
  {
    /**
     * Name of the application the option is attached to.
     */
    applicationName: string;
    /**
     * ARN of the CloudWatch Logs log stream receiving application messages.
     */
    logStreamArn: string;
    /**
     * Service-assigned ID of the logging option within the application.
     */
    cloudWatchLoggingOptionId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Attaches an Amazon CloudWatch Logs log stream to a Managed Service for
 * Apache Flink application so application messages (errors, job lifecycle
 * events) are delivered to CloudWatch.
 *
 * The option is identified by the log stream it delivers to — changing
 * either the application or the log stream replaces the option. The
 * application's service execution role must be allowed to call
 * `logs:PutLogEvents` / `logs:DescribeLogStreams` (the role auto-created by
 * `Application` already is).
 * @resource
 * @section Attaching Logging
 * @example Deliver application messages to a log stream
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const logGroup = yield* AWS.Logs.LogGroup("FlinkLogs");
 * const logStream = yield* AWS.Logs.LogStream("FlinkLogStream", {
 *   logGroupName: logGroup.logGroupName,
 * });
 * const logging = yield* AWS.KinesisAnalyticsV2.ApplicationCloudWatchLoggingOption(
 *   "AppLogging",
 *   {
 *     applicationName: app.applicationName,
 *     logStreamArn: logStream.logStreamArn.as<string>(),
 *   },
 * );
 * ```
 */
export const ApplicationCloudWatchLoggingOption =
  Resource<ApplicationCloudWatchLoggingOption>(
    "AWS.KinesisAnalyticsV2.ApplicationCloudWatchLoggingOption",
  );

/**
 * The logging option could not be observed on the application after it was
 * added — the add call succeeded but the option never appeared.
 */
export class LoggingOptionNotFound extends Data.TaggedError(
  "LoggingOptionNotFound",
)<{
  readonly applicationName: string;
  readonly logStreamArn: string;
}> {}

/**
 * Retries `ResourceInUseException` / `ConcurrentModificationException`
 * (application transitioning between statuses, or a concurrent operation in
 * flight) on a bounded schedule. Explicit return annotation for the same
 * declaration-emit reason as `retryThroughRolePropagation` in
 * `Application.ts`.
 */
const retryWhileInUse = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "ResourceInUseException" ||
      e._tag === "ConcurrentModificationException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

const describeApplicationDetail = Effect.fn(function* (
  applicationName: string,
) {
  const response = yield* analytics
    .describeApplication({ ApplicationName: applicationName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return response?.ApplicationDetail;
});

const findOption = (
  detail: analytics.ApplicationDetail | undefined,
  logStreamArn: string,
) =>
  detail?.CloudWatchLoggingOptionDescriptions?.find(
    (option) => option.LogStreamARN === logStreamArn,
  );

export const ApplicationCloudWatchLoggingOptionProvider = () =>
  Provider.effect(
    ApplicationCloudWatchLoggingOption,
    Effect.gen(function* () {
      return ApplicationCloudWatchLoggingOption.Provider.of({
        stables: [
          "applicationName",
          "logStreamArn",
          "cloudWatchLoggingOptionId",
        ],

        // Sub-resource keyed by its parent application — there is no
        // account-level enumeration of logging options, so `list` is empty
        // and refresh flows through `read` on known instances.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const applicationName =
            output?.applicationName ?? olds?.applicationName;
          const logStreamArn = output?.logStreamArn ?? olds?.logStreamArn;
          if (!applicationName || !logStreamArn) return undefined;
          const detail = yield* describeApplicationDetail(applicationName);
          const option = findOption(detail, logStreamArn);
          if (!option) return undefined;
          return {
            applicationName,
            logStreamArn,
            cloudWatchLoggingOptionId: option.CloudWatchLoggingOptionId,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // The option's identity is (application, log stream) — the only
          // way to change either is to delete and re-add.
          if (
            olds?.applicationName !== news?.applicationName ||
            olds?.logStreamArn !== news?.logStreamArn
          ) {
            return { action: "replace" } as const;
          }
        }),

        // Existence-only sub-resource: observe → if missing, add. The add
        // uses the freshly observed application version id as its
        // compare-and-set token and is retried through concurrent
        // modifications with a re-read.
        reconcile: Effect.fn(function* ({ news, session }) {
          const applicationName = news.applicationName;
          const logStreamArn = news.logStreamArn;

          const ensureOption = Effect.gen(function* () {
            const detail = yield* describeApplicationDetail(applicationName);
            const existing = findOption(detail, logStreamArn);
            if (existing || !detail) return existing;
            const response =
              yield* analytics.addApplicationCloudWatchLoggingOption({
                ApplicationName: applicationName,
                CurrentApplicationVersionId: detail.ApplicationVersionId,
                CloudWatchLoggingOption: { LogStreamARN: logStreamArn },
              });
            return response.CloudWatchLoggingOptionDescriptions?.find(
              (option) => option.LogStreamARN === logStreamArn,
            );
          });
          const option = yield* retryWhileInUse(ensureOption);
          if (!option) {
            return yield* Effect.fail(
              new LoggingOptionNotFound({ applicationName, logStreamArn }),
            );
          }

          yield* session.note(
            `CloudWatch logging option ${option.CloudWatchLoggingOptionId ?? logStreamArn}`,
          );
          return {
            applicationName,
            logStreamArn,
            cloudWatchLoggingOptionId: option.CloudWatchLoggingOptionId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A missing application means the option is already gone.
          const removeOption = Effect.gen(function* () {
            const detail = yield* describeApplicationDetail(
              output.applicationName,
            );
            const option = findOption(detail, output.logStreamArn);
            const optionId =
              option?.CloudWatchLoggingOptionId ??
              output.cloudWatchLoggingOptionId;
            if (!detail || !option || !optionId) return;
            yield* analytics
              .deleteApplicationCloudWatchLoggingOption({
                ApplicationName: output.applicationName,
                CurrentApplicationVersionId: detail.ApplicationVersionId,
                CloudWatchLoggingOptionId: optionId,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          });
          yield* retryWhileInUse(removeOption);
        }),
      });
    }),
  );
