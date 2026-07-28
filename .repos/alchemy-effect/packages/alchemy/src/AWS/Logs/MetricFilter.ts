import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export type MetricTransformation = logs.MetricTransformation;

export interface MetricFilterProps {
  /**
   * Name of the log group the metric filter is attached to.
   * Changing this value replaces the metric filter.
   */
  logGroupName: string;
  /**
   * Name of the metric filter. The filter name is the identity of the filter
   * within the log group (put semantics upsert by name). If omitted, a unique
   * name is generated. Changing this value replaces the filter.
   */
  filterName?: string;
  /**
   * Filter pattern that selects and parses matching log events.
   * An empty string matches every log event.
   * @default ""
   */
  filterPattern?: string;
  /**
   * CloudWatch metrics emitted when the pattern matches
   * (metric name, namespace, value expression, optional dimensions and unit).
   */
  metricTransformations: MetricTransformation[];
  /**
   * Whether the metric filter applies to transformed logs when a log
   * transformer is configured on the log group.
   * @default false
   */
  applyOnTransformedLogs?: boolean;
}

export interface MetricFilter extends Resource<
  "AWS.Logs.MetricFilter",
  MetricFilterProps,
  {
    filterName: string;
    logGroupName: string;
    filterPattern: string;
    metricTransformations: MetricTransformation[];
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Logs metric filter — extracts CloudWatch metrics from log
 * events matching a filter pattern.
 * @resource
 * @section Extracting Metrics
 * @example Count Error Log Lines
 * ```typescript
 * const errors = yield* MetricFilter("ErrorCount", {
 *   logGroupName: logGroup.logGroupName,
 *   filterPattern: "?ERROR ?Error",
 *   metricTransformations: [
 *     {
 *       metricName: "ErrorCount",
 *       metricNamespace: "MyApp",
 *       metricValue: "1",
 *       defaultValue: 0,
 *     },
 *   ],
 * });
 * ```
 *
 * @example Extract a Latency Value from JSON Logs
 * ```typescript
 * const latency = yield* MetricFilter("RequestLatency", {
 *   logGroupName: logGroup.logGroupName,
 *   filterPattern: "{ $.latencyMs = * }",
 *   metricTransformations: [
 *     {
 *       metricName: "LatencyMs",
 *       metricNamespace: "MyApp",
 *       metricValue: "$.latencyMs",
 *       unit: "Milliseconds",
 *     },
 *   ],
 * });
 * ```
 */
export const MetricFilter = Resource<MetricFilter>("AWS.Logs.MetricFilter");

export const MetricFilterProvider = () =>
  Provider.effect(
    MetricFilter,
    Effect.gen(function* () {
      const toFilterName = (id: string, props: { filterName?: string } = {}) =>
        props.filterName
          ? Effect.succeed(props.filterName)
          : createPhysicalName({ id, maxLength: 512 });

      const toAttributes = (
        logGroupName: string,
        filter: logs.MetricFilter & { filterName: string },
      ) => ({
        filterName: filter.filterName,
        logGroupName,
        filterPattern: filter.filterPattern ?? "",
        metricTransformations: (filter.metricTransformations ??
          []) as MetricTransformation[],
      });

      const observe = Effect.fn(function* (
        logGroupName: string,
        filterName: string,
      ) {
        const described = yield* logs
          .describeMetricFilters({
            logGroupName,
            filterNamePrefix: filterName,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ metricFilters: [] }),
            ),
          );
        return (described.metricFilters ?? []).find(
          (filter): filter is logs.MetricFilter & { filterName: string } =>
            filter.filterName === filterName,
        );
      });

      return {
        stables: ["filterName", "logGroupName"],
        // describeMetricFilters supports account-wide enumeration when no
        // logGroupName is given.
        list: () =>
          logs.describeMetricFilters.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.metricFilters ?? [])
                .filter(
                  (
                    filter,
                  ): filter is logs.MetricFilter & {
                    filterName: string;
                    logGroupName: string;
                  } => filter.filterName != null && filter.logGroupName != null,
                )
                .map((filter) => toAttributes(filter.logGroupName, filter)),
            ),
          ),
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

          // Observe — putMetricFilter has natural upsert semantics keyed by
          // filter name; observation only decides whether to skip the put.
          const observed = yield* observe(logGroupName, filterName);
          const upToDate =
            observed !== undefined &&
            (observed.filterPattern ?? "") === desiredPattern &&
            JSON.stringify(observed.metricTransformations ?? []) ===
              JSON.stringify(news.metricTransformations) &&
            (news.applyOnTransformedLogs === undefined ||
              observed.applyOnTransformedLogs === news.applyOnTransformedLogs);

          if (!upToDate) {
            yield* logs
              .putMetricFilter({
                logGroupName,
                filterName,
                filterPattern: desiredPattern,
                metricTransformations: news.metricTransformations,
                applyOnTransformedLogs: news.applyOnTransformedLogs,
              })
              .pipe(
                Effect.retry({
                  while: (error) =>
                    error._tag === "OperationAbortedException" ||
                    error._tag === "ServiceUnavailableException",
                  schedule: Schedule.exponential(100),
                  times: 8,
                }),
              );
          }

          yield* session.note(`${logGroupName}:${filterName}`);

          return {
            filterName,
            logGroupName,
            filterPattern: desiredPattern,
            metricTransformations: news.metricTransformations,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteMetricFilter({
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
