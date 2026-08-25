import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export type SubscriptionDistribution = logs.Distribution;

export interface SubscriptionFilterProps {
  /**
   * Name of the log group the subscription filter is attached to.
   * Changing this value replaces the subscription filter.
   */
  logGroupName: string;
  /**
   * Name of the subscription filter. The filter name is the identity of the
   * filter within the log group (put semantics upsert by name). If omitted, a
   * unique name is generated. Changing this value replaces the filter.
   */
  filterName?: string;
  /**
   * Filter pattern selecting which log events are delivered to the
   * destination. An empty string matches every log event.
   * @default ""
   */
  filterPattern?: string;
  /**
   * ARN of the destination that receives matching log events: a Lambda
   * function, a Kinesis stream, a Firehose delivery stream, or a cross-account
   * logs destination.
   */
  destinationArn: string;
  /**
   * ARN of an IAM role that CloudWatch Logs assumes to write to the
   * destination. Required for Kinesis / Firehose destinations; not used for
   * Lambda destinations (which authorize via a Lambda resource policy).
   */
  roleArn?: string;
  /**
   * How log data is distributed to a Kinesis stream destination.
   * @default "ByLogStream"
   */
  distribution?: SubscriptionDistribution;
  /**
   * Whether the subscription filter applies to transformed logs when a log
   * transformer is configured on the log group.
   * @default false
   */
  applyOnTransformedLogs?: boolean;
}

export interface SubscriptionFilter extends Resource<
  "AWS.Logs.SubscriptionFilter",
  SubscriptionFilterProps,
  {
    filterName: string;
    logGroupName: string;
    filterPattern: string;
    destinationArn: string;
    roleArn?: string;
    distribution?: SubscriptionDistribution;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Logs subscription filter — fans matching log events out of a
 * log group to a Lambda function, Kinesis stream, Firehose delivery stream, or
 * cross-account logs destination. A log group supports at most two
 * subscription filters.
 *
 * For the Lambda-consumer DX (subscribe a Lambda to a log group with automatic
 * permission wiring and payload decoding), prefer
 * {@link import("./LogGroupEventSource.ts").consumeLogEvents}.
 * @resource
 * @section Subscribing a Lambda Function
 * @example Deliver Error Logs to a Lambda Function
 * ```typescript
 * const filter = yield* SubscriptionFilter("ErrorFanout", {
 *   logGroupName: logGroup.logGroupName,
 *   filterPattern: "?ERROR ?Error",
 *   destinationArn: fn.functionArn,
 * });
 * ```
 *
 * @section Subscribing a Kinesis Stream
 * @example Deliver All Logs to Kinesis
 * ```typescript
 * const filter = yield* SubscriptionFilter("StreamFanout", {
 *   logGroupName: logGroup.logGroupName,
 *   filterPattern: "",
 *   destinationArn: stream.streamArn,
 *   roleArn: role.roleArn,
 *   distribution: "ByLogStream",
 * });
 * ```
 */
export const SubscriptionFilter = Resource<SubscriptionFilter>(
  "AWS.Logs.SubscriptionFilter",
);

/**
 * `putSubscriptionFilter` validates delivery to the destination at call time.
 * When the Lambda permission / IAM role for the destination was created in the
 * same deploy, that validation can fail with `InvalidParameterException`
 * ("Could not execute the lambda function..." / "Could not deliver test
 * message...") until IAM propagates. Retry on a bounded schedule; a genuine
 * validation error still surfaces after the window.
 *
 * NOTE: explicit return annotation is load-bearing — an inlined `Effect.retry`
 * in provider lifecycle code widens the provider layer during declaration emit
 * (see PATTERNS.md §7).
 */
const retryThroughDestinationValidation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidParameterException" ||
      e._tag === "OperationAbortedException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(9)]),
  });

export const SubscriptionFilterProvider = () =>
  Provider.effect(
    SubscriptionFilter,
    Effect.gen(function* () {
      const toFilterName = (id: string, props: { filterName?: string } = {}) =>
        props.filterName
          ? Effect.succeed(props.filterName)
          : createPhysicalName({ id, maxLength: 512 });

      const toAttributes = (
        logGroupName: string,
        filter: logs.SubscriptionFilter & { filterName: string },
      ) => ({
        filterName: filter.filterName,
        logGroupName,
        filterPattern: filter.filterPattern ?? "",
        destinationArn: filter.destinationArn ?? "",
        roleArn: filter.roleArn,
        distribution: filter.distribution,
      });

      const observe = Effect.fn(function* (
        logGroupName: string,
        filterName: string,
      ) {
        return yield* logs.describeSubscriptionFilters
          .items({
            logGroupName,
            filterNamePrefix: filterName,
          })
          .pipe(
            Stream.filter(
              (
                filter,
              ): filter is logs.SubscriptionFilter & { filterName: string } =>
                filter.filterName === filterName,
            ),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["filterName", "logGroupName"],
        // Subscription filters have no account-wide list API — fan out over
        // every log group (a group holds at most two filters).
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
                logs.describeSubscriptionFilters.items({ logGroupName }).pipe(
                  Stream.filter(
                    (
                      filter,
                    ): filter is logs.SubscriptionFilter & {
                      filterName: string;
                    } => filter.filterName != null,
                  ),
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).map((filter) =>
                      toAttributes(logGroupName, filter),
                    ),
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
            (yield* toFilterName(id, olds)) !== (yield* toFilterName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const logGroupName = output?.logGroupName ?? olds?.logGroupName;
          if (logGroupName === undefined) return undefined;
          const filterName =
            output?.filterName ?? (yield* toFilterName(id, olds ?? {}));
          const observed = yield* observe(logGroupName, filterName);
          if (!observed) return undefined;
          return toAttributes(logGroupName, observed);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const logGroupName = news.logGroupName;
          const filterName =
            output?.filterName ?? (yield* toFilterName(id, news));
          const desiredPattern = news.filterPattern ?? "";

          // Observe — the filter name is the identity within the log group and
          // putSubscriptionFilter has natural upsert semantics, so observation
          // only decides whether the put can be skipped entirely.
          const observed = yield* observe(logGroupName, filterName);
          const upToDate =
            observed !== undefined &&
            (observed.filterPattern ?? "") === desiredPattern &&
            observed.destinationArn === news.destinationArn &&
            observed.roleArn === news.roleArn &&
            (news.distribution === undefined ||
              observed.distribution === news.distribution) &&
            (news.applyOnTransformedLogs === undefined ||
              observed.applyOnTransformedLogs === news.applyOnTransformedLogs);

          if (!upToDate) {
            yield* retryThroughDestinationValidation(
              logs.putSubscriptionFilter({
                logGroupName,
                filterName,
                filterPattern: desiredPattern,
                destinationArn: news.destinationArn,
                roleArn: news.roleArn,
                distribution: news.distribution,
                applyOnTransformedLogs: news.applyOnTransformedLogs,
              }),
            );
          }

          yield* session.note(`${logGroupName}:${filterName}`);

          return {
            filterName,
            logGroupName,
            filterPattern: desiredPattern,
            destinationArn: news.destinationArn,
            roleArn: news.roleArn,
            distribution: news.distribution,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteSubscriptionFilter({
              logGroupName: output.logGroupName,
              filterName: output.filterName,
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
        }),
      };
    }),
  );
