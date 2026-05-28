import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { dual } from "effect/Function";
import * as Metric from "effect/Metric";

export const relayEnvironmentLinksTotal = Metric.counter("relay_environment_links_total", {
  description: "Total relay environment link lifecycle operations.",
});

export const relayManagedTunnelProvisionsTotal = Metric.counter(
  "relay_managed_tunnel_provisions_total",
  {
    description: "Total managed tunnel provisioning outcomes.",
  },
);

export const relayManagedTunnelsActive = Metric.gauge("relay_managed_tunnels_active", {
  description: "Current active relay links that use managed tunnels.",
});

export const relayEnvironmentLinksActive = Metric.gauge("relay_environment_links_active", {
  description: "Current active relay environment links.",
});

export const relayMobileDevicesRegistered = Metric.gauge("relay_mobile_devices_registered", {
  description: "Current registered mobile devices.",
});

export const relayLiveActivityTargetsActive = Metric.gauge("relay_live_activity_targets_active", {
  description: "Current active Live Activity targets.",
});

export const relayAgentActivityPublishesTotal = Metric.counter(
  "relay_agent_activity_publishes_total",
  {
    description: "Total agent activity publish and replay operations.",
  },
);

export const relayAgentActivitiesActive = Metric.gauge("relay_agent_activities_active", {
  description: "Observed active agent activity count in delivered aggregates.",
});

export const relayApnsDeliveriesTotal = Metric.counter("relay_apns_deliveries_total", {
  description: "Total APNS delivery selections, queue jobs, and send outcomes.",
});

export type RelayMetricAttributes = Readonly<Record<string, unknown>>;

export const metricAttributes = (
  attributes: RelayMetricAttributes,
): ReadonlyArray<[string, string]> =>
  Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)]);

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: RelayMetricAttributes,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export const updateGauge = (
  metric: Metric.Metric<number, unknown>,
  attributes: RelayMetricAttributes,
  value: number,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), value);

export const recordDurationMillis = (
  metric: Metric.Metric<Duration.Duration, unknown>,
  attributes: RelayMetricAttributes,
  elapsedMillis: number,
) =>
  Metric.update(
    Metric.withAttributes(metric, metricAttributes(attributes)),
    Duration.millis(elapsedMillis),
  );

const outcomeFromExit = <A, E>(exit: Exit.Exit<A, E>): "success" | "failure" =>
  Exit.isSuccess(exit) ? "success" : "failure";

const errorTag = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : error instanceof Error
      ? error.name
      : typeof error;

export interface WithMetricsOptions<E = unknown> {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?: RelayMetricAttributes | (() => RelayMetricAttributes);
  readonly outcomeAttributes?: (input: {
    readonly outcome: "success" | "failure";
    readonly error: E | null;
  }) => RelayMetricAttributes;
}

const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions<E>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos;
    const exit = yield* Effect.exit(effect);
    const endedAt = yield* Clock.currentTimeNanos;
    const elapsedNanos = endedAt > startedAt ? endedAt - startedAt : 0n;
    const duration = Duration.nanos(elapsedNanos);
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});
    const outcome = outcomeFromExit(exit);
    const error = Exit.isSuccess(exit) ? null : (Cause.squash(exit.cause) as E);

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      yield* increment(options.counter, {
        ...baseAttributes,
        outcome,
        ...(options.outcomeAttributes ? options.outcomeAttributes({ outcome, error }) : {}),
      });
    }

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    return yield* Effect.failCause(exit.cause);
  });

export const withMetrics: {
  <A, E, R>(
    options: WithMetricsOptions<E>,
  ): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions<E>): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);

export const errorMetricTag = errorTag;
