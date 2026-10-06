import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import { dual } from "effect/Function";

import { compactMetricAttributes, outcomeFromExit } from "./Attributes.ts";

export const rpcRequestsTotal = Metric.counter("t3_rpc_requests_total", {
  description: "Total RPC requests handled by the websocket RPC server.",
});

export const rpcRequestDuration = Metric.timer("t3_rpc_request_duration", {
  description: "RPC request handling duration.",
});

export const orchestrationEffectClaimsTotal = Metric.counter(
  "t3_orchestration_effect_claims_total",
  {
    description: "Total completed orchestration effect outbox claim attempts by result.",
  },
);

export const orchestrationEffectQueueWait = Metric.timer("t3_orchestration_effect_queue_wait", {
  description:
    "Time from an orchestration effect's temporal availability until claim, including same-thread blocking.",
});

export const providerSessionsTotal = Metric.counter("t3_provider_sessions_total", {
  description: "Total provider session lifecycle operations.",
});

export const providerTurnsTotal = Metric.counter("t3_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("t3_provider_turn_duration", {
  description: "Time for the provider adapter to start a turn, not how long the turn runs.",
});

export const gitCommandsTotal = Metric.counter("t3_git_commands_total", {
  description: "Total git commands executed by the server runtime.",
});

export const gitCommandDuration = Metric.timer("t3_git_command_duration", {
  description: "Git command execution duration.",
});

export const terminalSessionsTotal = Metric.counter("t3_terminal_sessions_total", {
  description: "Total terminal sessions started.",
});

export const terminalRestartsTotal = Metric.counter("t3_terminal_restarts_total", {
  description: "Total terminal restart requests handled.",
});

/**
 * One per webhook request that reached a task, by `outcome` (accepted,
 * not_found, rejected_signature, disabled, rate_limited, queue_full, expired,
 * prompt_too_long, error) and `source` (relay or direct).
 */
export const webhookDeliveriesTotal = Metric.counter("t3_webhook_deliveries_total", {
  description: "Webhook requests handled, by outcome and source.",
});

export const webhookDeliveryDuration = Metric.timer("t3_webhook_delivery_duration", {
  description: "Time to verify, log, and enqueue one webhook request.",
});

/** How long a relay-held request waited before this environment got it. */
export const webhookHeldDelay = Metric.timer("t3_webhook_held_delay", {
  description:
    "Time between the relay receiving a webhook request and the environment handling it.",
});

/** Runs started by webhook deliveries, by `outcome` (started, skipped, failed). */
export const webhookRunsTotal = Metric.counter("t3_webhook_runs_total", {
  description: "Runs started from webhook deliveries, by outcome.",
});

/** Secrets agents asked users for, by how each ended: saved, declined, cancelled, timed_out. */
export const secretRequestsTotal = Metric.counter("t3_secret_requests_total", {
  description: "Secrets agents asked users for, by how each request ended.",
});

/** One-use secret refs a tool tried to use, by result: used, rejected. */
export const secretRefsConsumedTotal = Metric.counter("t3_secret_refs_consumed_total", {
  description: "Secret refs tools tried to use, by result.",
});

export const metricAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<[string, string]> => Object.entries(compactMetricAttributes(attributes));

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Readonly<Record<string, unknown>>,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export interface WithMetricsOptions {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>;
}

const recordMetrics = (
  options: WithMetricsOptions,
  startedAt: bigint,
  exit: Exit.Exit<unknown, unknown>,
) =>
  Effect.gen(function* () {
    const duration = Duration.nanos((yield* Clock.monotonicTimeNanos) - startedAt);
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      const outcome = outcomeFromExit(exit);
      yield* Metric.update(
        Metric.withAttributes(
          options.counter,
          metricAttributes({
            ...baseAttributes,
            outcome,
            ...(options.outcomeAttributes ? options.outcomeAttributes(outcome) : {}),
          }),
        ),
        1,
      );
    }
  });

// Durations come from the monotonic clock, so wall-clock corrections cannot skew them, and
// metrics are recorded in an exit finalizer, so interrupted work is counted as "interrupt".
const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.monotonicTimeNanos, (startedAt) =>
    Effect.onExit(effect, (exit) => recordMetrics(options, startedAt, exit)),
  );

export const withMetrics: {
  (
    options: WithMetricsOptions,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);
