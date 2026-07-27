import * as rum from "@distilled.cloud/aws/rum";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * One extended or custom metric a RUM app monitor derives from its telemetry
 * events and sends to the destination.
 */
export interface MetricDefinition {
  /**
   * Name of the metric. For extended metrics this must be one of the valid
   * extended metric names (e.g. `SessionCount`, `JsErrorCount`); for custom
   * metrics (CloudWatch destinations with a `namespace`) any name is
   * allowed.
   */
  name: string;
  /**
   * Field within the event to use as the metric value. Omit to count
   * matching events (value 1 per event).
   */
  valueKey?: string;
  /**
   * CloudWatch metric unit label (e.g. `Count`, `Milliseconds`).
   */
  unitLabel?: string;
  /**
   * Extra dimensions derived from event fields — maps the event field path
   * (e.g. `metadata.browserName`) to the dimension name (e.g.
   * `BrowserName`).
   */
  dimensionKeys?: Record<string, string>;
  /**
   * JSON event-pattern filter — only events matching the pattern contribute
   * to the metric. Required for extended metrics, where it must match the
   * metric's event type (e.g.
   * `{"event_type":["com.amazon.rum.session_start_event"]}` for
   * `SessionCount`).
   */
  eventPattern?: string;
  /**
   * Custom-metric namespace (CloudWatch destinations only). RUM prepends
   * `RUM/CustomMetrics/`; it must not start with `AWS/`. Omit for extended
   * metrics.
   */
  namespace?: string;
}

export interface MetricsDestinationProps {
  /**
   * Name of the CloudWatch RUM app monitor that sends metrics to this
   * destination. Changing it replaces the destination.
   */
  appMonitorName: string;
  /**
   * Where the extended/custom metrics are sent. Changing it replaces the
   * destination.
   */
  destination: "CloudWatch" | "Evidently";
  /**
   * ARN of the CloudWatch Evidently experiment receiving the metrics.
   * Required when `destination` is `"Evidently"`; changing it replaces the
   * destination.
   */
  destinationArn?: string;
  /**
   * ARN of the IAM role RUM assumes to write to the Evidently experiment.
   * Required when `destination` is `"Evidently"`.
   */
  iamRoleArn?: string;
  /**
   * The extended/custom metric definitions the app monitor sends to this
   * destination. Synced in place: added, updated, and removed definitions
   * converge to this list.
   */
  metricDefinitions?: MetricDefinition[];
}

export interface MetricsDestination extends Resource<
  "AWS.RUM.MetricsDestination",
  MetricsDestinationProps,
  {
    /**
     * Name of the app monitor sending metrics.
     */
    appMonitorName: string;
    /**
     * The destination kind (`CloudWatch` or `Evidently`).
     */
    destination: "CloudWatch" | "Evidently";
    /**
     * ARN of the Evidently experiment, when `destination` is `Evidently`.
     */
    destinationArn: string | undefined;
    /**
     * IAM role RUM assumes to write to the destination, when set.
     */
    iamRoleArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A destination for CloudWatch RUM extended and custom metrics — sends
 * metrics that a RUM app monitor derives from its telemetry events to
 * CloudWatch or to a CloudWatch Evidently experiment, including the metric
 * definitions themselves.
 *
 * @resource
 * @section Creating a Metrics Destination
 * @example Send Extended Metrics to CloudWatch
 * ```typescript
 * const monitor = yield* RUM.AppMonitor("SiteMonitor", {
 *   domain: "example.com",
 * });
 * const metrics = yield* RUM.MetricsDestination("SiteMetrics", {
 *   appMonitorName: monitor.appMonitorName,
 *   destination: "CloudWatch",
 *   // extended metrics require the event pattern matching the metric
 *   metricDefinitions: [
 *     {
 *       name: "SessionCount",
 *       eventPattern: JSON.stringify({
 *         event_type: ["com.amazon.rum.session_start_event"],
 *       }),
 *     },
 *   ],
 * });
 * ```
 *
 * @section Custom Metrics
 * @example Derive a Custom Metric from Events
 * ```typescript
 * const metrics = yield* RUM.MetricsDestination("CustomMetrics", {
 *   appMonitorName: monitor.appMonitorName,
 *   destination: "CloudWatch",
 *   metricDefinitions: [
 *     {
 *       name: "Checkouts",
 *       namespace: "MyApp",
 *       unitLabel: "Count",
 *       eventPattern: JSON.stringify({
 *         event_type: ["com.example.checkout"],
 *       }),
 *     },
 *   ],
 * });
 * ```
 */
export const MetricsDestination = Resource<MetricsDestination>(
  "AWS.RUM.MetricsDestination",
);

/**
 * Raised when a `BatchCreateRumMetricDefinitions` /
 * `BatchDeleteRumMetricDefinitions` call reports per-definition errors.
 */
export class RumMetricDefinitionsError extends Data.TaggedError(
  "RumMetricDefinitionsError",
)<{ message: string }> {}

const toWireDefinition = (
  def: MetricDefinition,
): rum.MetricDefinitionRequest => ({
  Name: def.name,
  ValueKey: def.valueKey,
  UnitLabel: def.unitLabel,
  DimensionKeys: def.dimensionKeys,
  EventPattern: def.eventPattern,
  Namespace: def.namespace,
});

const sameRecord = (
  a: Record<string, string | undefined> | undefined,
  b: Record<string, string | undefined> | undefined,
) => {
  const left = Object.entries(a ?? {}).filter(([, v]) => v !== undefined);
  const right = Object.entries(b ?? {}).filter(([, v]) => v !== undefined);
  return (
    left.length === right.length && left.every(([k, v]) => (b ?? {})[k] === v)
  );
};

const definitionInSync = (
  observed: rum.MetricDefinition,
  desired: MetricDefinition,
) =>
  observed.ValueKey === desired.valueKey &&
  observed.UnitLabel === desired.unitLabel &&
  observed.EventPattern === desired.eventPattern &&
  observed.Namespace === desired.namespace &&
  sameRecord(observed.DimensionKeys, desired.dimensionKeys);

export const MetricsDestinationProvider = () =>
  Provider.effect(
    MetricsDestination,
    Effect.gen(function* () {
      /**
       * Observe the live destination on the monitor; typed not-found (the
       * monitor itself is gone) → undefined.
       */
      const observeDestination = Effect.fn(function* (
        props: Pick<
          MetricsDestinationProps,
          "appMonitorName" | "destination" | "destinationArn"
        >,
      ) {
        const destinations = yield* rum.listRumMetricsDestinations
          .items({ AppMonitorName: props.appMonitorName })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed([] as rum.MetricDestinationSummary[]),
            ),
          );
        return Array.from(destinations).find(
          (d) =>
            d.Destination === props.destination &&
            (props.destination !== "Evidently" ||
              d.DestinationArn === props.destinationArn),
        );
      });

      const toAttrs = (
        props: MetricsDestinationProps,
        observed: rum.MetricDestinationSummary | undefined,
      ) => ({
        appMonitorName: props.appMonitorName,
        destination: props.destination,
        destinationArn: props.destinationArn,
        iamRoleArn: observed?.IamRoleArn ?? props.iamRoleArn,
      });

      return {
        stables: ["appMonitorName", "destination", "destinationArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds?.appMonitorName !== news.appMonitorName ||
            olds?.destination !== news.destination ||
            olds?.destinationArn !== news.destinationArn
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const identity = output ?? olds;
          if (!identity) return undefined;
          const observed = yield* observeDestination(identity);
          if (observed === undefined) return undefined;
          // Metrics destinations are not taggable — ownership is implied by
          // the owned parent app monitor.
          return {
            appMonitorName: identity.appMonitorName,
            destination: identity.destination,
            destinationArn: identity.destinationArn,
            iamRoleArn: observed.IamRoleArn,
          };
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          const props = news!;
          const key = {
            AppMonitorName: props.appMonitorName,
            Destination: props.destination,
            ...(props.destination === "Evidently"
              ? { DestinationArn: props.destinationArn }
              : {}),
          };

          // 1. OBSERVE — the live destination list is authoritative.
          const observed = yield* observeDestination(props);

          // 2. ENSURE + SYNC destination — `putRumMetricsDestination` is a
          //    true upsert; call it when missing or when the role drifts. A
          //    concurrent put surfaces as the typed ConflictException — a
          //    race, not a failure.
          if (
            observed === undefined ||
            (props.iamRoleArn !== undefined &&
              observed.IamRoleArn !== props.iamRoleArn)
          ) {
            yield* rum
              .putRumMetricsDestination({
                ...key,
                IamRoleArn: props.iamRoleArn,
              })
              .pipe(
                Effect.asVoid,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
          }

          // 3. SYNC metric definitions — diff the OBSERVED definitions
          //    (keyed by name) against the desired list and apply only the
          //    delta: batch-create missing, update drifted, batch-delete
          //    extraneous.
          const live = yield* rum.batchGetRumMetricDefinitions.items(key).pipe(
            Stream.runCollect,
            Effect.map((c) => Array.from(c)),
          );
          const desired = props.metricDefinitions ?? [];
          const liveByName = new Map(live.map((d) => [d.Name, d]));
          const desiredNames = new Set(desired.map((d) => d.name));

          const toCreate = desired.filter((d) => !liveByName.has(d.name));
          if (toCreate.length > 0) {
            const { Errors } = yield* rum.batchCreateRumMetricDefinitions({
              ...key,
              MetricDefinitions: toCreate.map(toWireDefinition),
            });
            if (Errors.length > 0) {
              yield* Effect.fail(
                new RumMetricDefinitionsError({
                  message: `failed to create ${Errors.length} metric definition(s): ${Errors.map(
                    (e) => `${e.MetricDefinition.Name}: ${e.ErrorMessage}`,
                  ).join("; ")}`,
                }),
              );
            }
          }

          yield* Effect.forEach(
            desired.flatMap((d) => {
              const current = liveByName.get(d.name);
              return current !== undefined && !definitionInSync(current, d)
                ? [{ id: current.MetricDefinitionId, definition: d }]
                : [];
            }),
            ({ id, definition }) =>
              rum.updateRumMetricDefinition({
                ...key,
                MetricDefinitionId: id,
                MetricDefinition: toWireDefinition(definition),
              }),
          );

          const toDelete = live.filter((d) => !desiredNames.has(d.Name));
          if (toDelete.length > 0) {
            const { Errors } = yield* rum.batchDeleteRumMetricDefinitions({
              ...key,
              MetricDefinitionIds: toDelete.map((d) => d.MetricDefinitionId),
            });
            if (Errors.length > 0) {
              yield* Effect.fail(
                new RumMetricDefinitionsError({
                  message: `failed to delete ${Errors.length} metric definition(s): ${Errors.map(
                    (e) => `${e.MetricDefinitionId}: ${e.ErrorMessage}`,
                  ).join("; ")}`,
                }),
              );
            }
          }

          yield* session.note(`${props.appMonitorName}/${props.destination}`);
          const final = yield* observeDestination(props);
          return toAttrs(props, final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* rum
            .deleteRumMetricsDestination({
              AppMonitorName: output.appMonitorName,
              Destination: output.destination,
              ...(output.destination === "Evidently"
                ? { DestinationArn: output.destinationArn }
                : {}),
            })
            .pipe(
              // idempotent — the destination (or its whole monitor) may be gone
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
            );
        }),

        // Sub-resource keyed by its parent app monitor — enumerating it
        // would require listing every monitor's destinations.
        list: () => Effect.succeed([]),
      };
    }),
  );
