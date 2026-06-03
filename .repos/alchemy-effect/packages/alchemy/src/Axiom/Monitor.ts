import * as Axiom from "@distilled.cloud/axiom";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type MonitorProps = Axiom.CreateMonitorInput;

export type Monitor = Resource<
  "Axiom.Monitor",
  MonitorProps,
  Axiom.CreateMonitorOutput,
  never,
  Providers
>;

/**
 * An Axiom monitor — a scheduled APL/MPL query that evaluates on a fixed
 * cadence and fires alerts via {@link Notifier notifiers} when its
 * condition is met.
 *
 * Three monitor `type`s are supported:
 *
 * - **`Threshold`** — fires when an aggregate result crosses a static
 *   `threshold` (compared with `operator`).
 * - **`MatchEvent`** — fires for every event matching the query.
 * - **`AnomalyDetection`** — fires when results deviate from a learned
 *   baseline by more than `tolerance` over `compareDays`.
 *
 * Changing `type` triggers a replacement; everything else updates in place.
 *
 * @see https://axiom.co/docs/monitor-data/monitors
 *
 * @section Creating a Monitor
 * @example Threshold: alert on >100 errors per 5m
 * ```typescript
 * yield* Axiom.Monitor("error-rate", {
 *   name: "High error rate",
 *   description: "Fires when error count exceeds 100/5m",
 *   type: "Threshold",
 *   aplQuery: `
 *     ['my-app-traces']
 *     | where status >= 500
 *     | summarize count() by bin_auto(_time)
 *   `,
 *   operator: "Above",
 *   threshold: 100,
 *   intervalMinutes: 5,
 *   rangeMinutes: 5,
 *   alertOnNoData: false,
 *   resolvable: true,
 *   notifierIds: [slack.id, pagerduty.id],
 * });
 * ```
 *
 * @example MatchEvent: alert on every panic
 * ```typescript
 * yield* Axiom.Monitor("panics", {
 *   name: "Service panic",
 *   type: "MatchEvent",
 *   aplQuery: `['my-app-logs'] | where message contains "panic:"`,
 *   intervalMinutes: 1,
 *   rangeMinutes: 1,
 *   notifierIds: [pagerduty.id],
 * });
 * ```
 *
 * @example AnomalyDetection: deviation vs. last 7 days
 * ```typescript
 * yield* Axiom.Monitor("traffic-anomaly", {
 *   name: "Traffic anomaly",
 *   type: "AnomalyDetection",
 *   aplQuery: `['my-app-traces'] | summarize count() by bin_auto(_time)`,
 *   compareDays: 7,
 *   tolerance: 25,             // %
 *   intervalMinutes: 15,
 *   rangeMinutes: 15,
 *   notifierIds: [slack.id],
 * });
 * ```
 */
export const Monitor = Resource<Monitor>("Axiom.Monitor");

export const MonitorProvider = () =>
  Provider.effect(
    Monitor,
    Effect.gen(function* () {
      const create = yield* Axiom.createMonitor;
      const update = yield* Axiom.updateMonitor;
      const get = yield* Axiom.getMonitor;
      const del = yield* Axiom.deleteMonitor;

      return {
        stables: ["id"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.type !== output.type) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — Axiom assigns the monitor id server-side, so the only
          // handle to a previously-created monitor is the cached
          // `output.id`. Probe for live state with that id; treat NotFound
          // (deleted out-of-band) as "no observed state" so we converge by
          // re-creating.
          const observed = output?.id
            ? yield* get({ id: output.id }).pipe(
                Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
              )
            : undefined;

          // Ensure — POST mints a new monitor with a fresh id.
          if (observed === undefined) {
            return yield* create(news);
          }

          // Sync — the monitor exists; PATCH against its id with the
          // desired props. `type` is replacement-only (handled in diff).
          return yield* update({ ...news, id: observed.id });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
