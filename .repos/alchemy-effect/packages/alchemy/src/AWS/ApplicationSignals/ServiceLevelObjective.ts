import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ServiceLevelObjectiveProps {
  /**
   * Name of the SLO (up to 127 characters, pattern
   * `[0-9A-Za-z][-._A-Za-z0-9 ]*`). Changing the name replaces the SLO —
   * the API has no rename operation.
   * @default ${app}-${stage}-${id}
   */
  sloName?: string;
  /**
   * A human-readable description of the SLO. Shown in the CloudWatch
   * console next to the SLO.
   */
  description?: string;
  /**
   * Period-based service level indicator: a CloudWatch metric (via
   * `SliMetricConfig.MetricDataQueries` for any metric or math expression,
   * or the `KeyAttributes`/`OperationName` shorthand for services discovered
   * by Application Signals), a `MetricThreshold`, and a `ComparisonOperator`.
   *
   * Exactly one of `sliConfig` or `requestBasedSliConfig` must be provided.
   * Switching between them replaces the SLO — the evaluation type of an
   * existing SLO cannot be changed.
   */
  sliConfig?: appsignals.ServiceLevelIndicatorConfig;
  /**
   * Request-based service level indicator: `TotalRequestCountMetric` plus a
   * `GoodCountMetric` or `BadCountMetric` under
   * `RequestBasedSliMetricConfig.MonitoredRequestCountMetric`.
   *
   * Exactly one of `sliConfig` or `requestBasedSliConfig` must be provided.
   * Switching between them replaces the SLO.
   */
  requestBasedSliConfig?: appsignals.RequestBasedServiceLevelIndicatorConfig;
  /**
   * The attainment goal for the SLO: the `Interval` (rolling or calendar),
   * the `AttainmentGoal` percentage, and the `WarningThreshold`.
   * @default rolling 7-day interval, 99% attainment, 30% warning threshold
   */
  goal?: appsignals.Goal;
  /**
   * Burn-rate windows to compute for the SLO. Each entry creates a burn-rate
   * metric over the given look-back window.
   */
  burnRateConfigurations?: appsignals.BurnRateConfiguration[];
  /**
   * Tags to apply to the SLO. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ServiceLevelObjective extends Resource<
  "AWS.ApplicationSignals.ServiceLevelObjective",
  ServiceLevelObjectiveProps,
  {
    /**
     * Name of the service level objective.
     */
    sloName: string;
    /**
     * ARN of the service level objective.
     */
    sloArn: string;
    /**
     * How the SLO is evaluated (`PeriodBased` or `RequestBased`).
     */
    evaluationType: appsignals.EvaluationType | undefined;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Application Signals service level objective (SLO) that tracks
 * an attainment goal against a service level indicator — any CloudWatch
 * metric or metric-math expression, or a service operation discovered by
 * Application Signals.
 * @resource
 * @section Creating Service Level Objectives
 * @example Period-based SLO on a CloudWatch metric
 * ```typescript
 * import * as ApplicationSignals from "alchemy/AWS/ApplicationSignals";
 *
 * const slo = yield* ApplicationSignals.ServiceLevelObjective("ApiLatency", {
 *   description: "p99 latency under 2 seconds",
 *   sliConfig: {
 *     SliMetricConfig: {
 *       MetricDataQueries: [
 *         {
 *           Id: "m1",
 *           MetricStat: {
 *             Metric: {
 *               Namespace: "AWS/Lambda",
 *               MetricName: "Duration",
 *               Dimensions: [{ Name: "FunctionName", Value: "my-api" }],
 *             },
 *             Period: 60,
 *             Stat: "p99",
 *           },
 *           ReturnData: true,
 *         },
 *       ],
 *     },
 *     MetricThreshold: 2000,
 *     ComparisonOperator: "LessThanOrEqualTo",
 *   },
 *   goal: {
 *     Interval: { RollingInterval: { DurationUnit: "DAY", Duration: 7 } },
 *     AttainmentGoal: 99,
 *     WarningThreshold: 50,
 *   },
 * });
 * ```
 *
 * @example Request-based SLO
 * ```typescript
 * const slo = yield* ApplicationSignals.ServiceLevelObjective("Availability", {
 *   requestBasedSliConfig: {
 *     RequestBasedSliMetricConfig: {
 *       TotalRequestCountMetric: [
 *         {
 *           Id: "total",
 *           MetricStat: {
 *             Metric: { Namespace: "AWS/ApplicationELB", MetricName: "RequestCount" },
 *             Period: 60,
 *             Stat: "Sum",
 *           },
 *           ReturnData: true,
 *         },
 *       ],
 *       MonitoredRequestCountMetric: {
 *         BadCountMetric: [
 *           {
 *             Id: "bad",
 *             MetricStat: {
 *               Metric: { Namespace: "AWS/ApplicationELB", MetricName: "HTTPCode_Target_5XX_Count" },
 *               Period: 60,
 *               Stat: "Sum",
 *             },
 *             ReturnData: true,
 *           },
 *         ],
 *       },
 *     },
 *   },
 *   goal: { AttainmentGoal: 99.9 },
 * });
 * ```
 */
export const ServiceLevelObjective = Resource<ServiceLevelObjective>(
  "AWS.ApplicationSignals.ServiceLevelObjective",
);

/**
 * Rebuild `Date` instances that the engine's state serialization flattened
 * to ISO strings (calendar intervals carry a `StartTime` timestamp).
 */
const normalizeGoal = (
  goal: appsignals.Goal | undefined,
): appsignals.Goal | undefined => {
  const interval = goal?.Interval;
  if (interval && "CalendarInterval" in interval && interval.CalendarInterval) {
    return {
      ...goal,
      Interval: {
        CalendarInterval: {
          ...interval.CalendarInterval,
          StartTime: new Date(interval.CalendarInterval.StartTime),
        },
      },
    };
  }
  return goal;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const toTime = (value: unknown): number =>
  value instanceof Date
    ? value.getTime()
    : new Date(value as string | number).getTime();

/**
 * Structural subset comparison: every DEFINED field of `desired` must
 * deep-equal the corresponding field of `observed`. Extra observed fields
 * (server-side defaults the API echoes back, e.g. `ReturnData`, resolved
 * account ids) are ignored, so a reconcile whose desired state matches the
 * cloud skips the update call entirely.
 */
const subsetMatches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (desired instanceof Date || observed instanceof Date) {
    return toTime(desired) === toTime(observed);
  }
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, index) => subsetMatches(item, observed[index]))
    );
  }
  if (isPlainObject(desired)) {
    return (
      isPlainObject(observed) &&
      Object.entries(desired).every(([key, value]) =>
        subsetMatches(value, observed[key]),
      )
    );
  }
  return desired === observed;
};

/** The mutable aspects of the SLO, in `UpdateServiceLevelObjective` shape. */
const desiredState = (news: ServiceLevelObjectiveProps) => ({
  Description: news.description,
  SliConfig: news.sliConfig,
  RequestBasedSliConfig: news.requestBasedSliConfig,
  Goal: normalizeGoal(news.goal),
  BurnRateConfigurations: news.burnRateConfigurations,
});

/** Project the observed SLO into the same shape as {@link desiredState}. */
const observedState = (slo: appsignals.ServiceLevelObjective) => ({
  Description: slo.Description,
  SliConfig: slo.Sli && {
    SliMetricConfig: slo.Sli.SliMetric,
    MetricThreshold: slo.Sli.MetricThreshold,
    ComparisonOperator: slo.Sli.ComparisonOperator,
  },
  RequestBasedSliConfig: slo.RequestBasedSli && {
    RequestBasedSliMetricConfig: slo.RequestBasedSli.RequestBasedSliMetric,
    MetricThreshold: slo.RequestBasedSli.MetricThreshold,
    ComparisonOperator: slo.RequestBasedSli.ComparisonOperator,
  },
  Goal: slo.Goal,
  BurnRateConfigurations: slo.BurnRateConfigurations,
});

export const ServiceLevelObjectiveProvider = () =>
  Provider.effect(
    ServiceLevelObjective,
    Effect.gen(function* () {
      const createSloName = Effect.fn(function* (
        id: string,
        props: Pick<ServiceLevelObjectiveProps, "sloName">,
      ) {
        // SLO names are limited to 127 characters.
        return (
          props.sloName ?? (yield* createPhysicalName({ id, maxLength: 127 }))
        );
      });

      // `Id` accepts the SLO name or ARN interchangeably.
      const observeSlo = (id: string) =>
        appsignals.getServiceLevelObjective({ Id: id }).pipe(
          Effect.map((r) => r.Slo),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const observedTags = (sloArn: string) =>
        appsignals.listTagsForResource({ ResourceArn: sloArn }).pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      return ServiceLevelObjective.Provider.of({
        stables: ["sloName", "sloArn"],
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* appsignals.listServiceLevelObjectives
              .items({})
              .pipe(Stream.runCollect);
            return Array.from(summaries).map((slo) => ({
              sloName: slo.Name,
              sloArn: slo.Arn,
              evaluationType: slo.EvaluationType,
            }));
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const sloName =
            output?.sloName ?? (yield* createSloName(id, olds ?? {}));
          const found = yield* observeSlo(sloName);
          if (!found) return undefined;
          const attrs = {
            sloName: found.Name,
            sloArn: found.Arn,
            evaluationType: found.EvaluationType,
          };
          const tags = yield* observedTags(found.Arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createSloName(id, olds ?? {});
          const newName = yield* createSloName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // An SLO cannot switch between period-based and request-based
          // evaluation — swapping the SLI config kind replaces the SLO.
          const oldKind = olds?.requestBasedSliConfig
            ? "RequestBased"
            : "PeriodBased";
          const newKind = news?.requestBasedSliConfig
            ? "RequestBased"
            : "PeriodBased";
          if (oldKind !== newKind) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const sloName = output?.sloName ?? (yield* createSloName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desired = desiredState(news);

          // 1. OBSERVE — cloud state is authoritative; `output` is only a
          //    cache for the physical name.
          let live = yield* observeSlo(sloName);

          if (live === undefined) {
            // 2. ENSURE — create when missing; a concurrent create surfaces
            //    as the typed ConflictException, which we treat as a race
            //    and re-observe.
            live = yield* appsignals
              .createServiceLevelObjective({
                Name: sloName,
                ...desired,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.Slo),
                Effect.catchTag("ConflictException", () => observeSlo(sloName)),
              );
          } else if (!subsetMatches(desired, observedState(live))) {
            // 3. SYNC — converge every mutable aspect with a single PATCH;
            //    skipped entirely when the observed state already satisfies
            //    the desired state (update retains omitted parameters).
            live = yield* appsignals
              .updateServiceLevelObjective({ Id: sloName, ...desired })
              .pipe(Effect.map((r) => r.Slo));
          }

          if (live === undefined) {
            return yield* Effect.fail(
              new Error(`failed to reconcile SLO '${sloName}'`),
            );
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (create-time Tags only apply on first create).
          const currentTags = yield* observedTags(live.Arn);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* appsignals.tagResource({
              ResourceArn: live.Arn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* appsignals.untagResource({
              ResourceArn: live.Arn,
              TagKeys: removed,
            });
          }

          yield* session.note(sloName);
          return {
            sloName: live.Name,
            sloArn: live.Arn,
            evaluationType: live.EvaluationType,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* appsignals
            .deleteServiceLevelObjective({ Id: output.sloName })
            .pipe(
              // Idempotent delete — already-gone is success.
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
