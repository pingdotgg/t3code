import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Monitor } from "./Monitor.ts";

/**
 * Shared scaffolding for Amazon CloudWatch Internet Monitor HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action is
 * boilerplate:
 *
 * - {@link makeInternetMonitorMonitorHttpBinding} — operations scoped to one
 *   bound {@link Monitor} (`ListHealthEvents`, `GetHealthEvent`, the query
 *   interface). The runtime callable injects the monitor's name as the
 *   request's `MonitorName`; the deploy-time half grants `actions` on the
 *   monitor ARN plus its sub-resources (health events are addressed as
 *   `{monitorArn}/health-event/{id}`).
 * - {@link makeInternetMonitorAccountHttpBinding} — account-level operations
 *   (`GetInternetEvent`, `ListInternetEvents`). Internet events are global
 *   outage records, not ARN-addressable resources, so the deploy-time half
 *   grants `actions` on `*`.
 */

/**
 * Build the impl Effect for an operation scoped to a single bound
 * {@link Monitor}. The runtime callable injects the monitor's name as the
 * request's `MonitorName`; the deploy-time half grants `actions` on the
 * monitor ARN and its sub-resources.
 */
export const makeInternetMonitorMonitorHttpBinding = <
  I extends { MonitorName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.InternetMonitor.ListHealthEvents`. */
  tag: string;
  /** The distilled operation; `MonitorName` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the monitor ARN (and its sub-resources). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (monitor: Monitor) {
      const MonitorName = yield* monitor.monitorName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${monitor}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                // Health events (and other per-monitor entities) are
                // addressed as sub-resources of the monitor ARN, e.g.
                // `{monitorArn}/health-event/{eventId}`.
                Resource: [
                  monitor.monitorArn,
                  Output.interpolate`${monitor.monitorArn}/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${monitor.LogicalId})`)(function* (
        request?: Omit<I, "MonitorName">,
      ) {
        return yield* op({
          ...request,
          MonitorName: yield* MonitorName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Internet Monitor operation. The
 * runtime callable passes the caller's request through unchanged; the
 * deploy-time half grants `actions` on `*` (internet events do not support
 * resource-level permissions).
 */
export const makeInternetMonitorAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.InternetMonitor.ListInternetEvents`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
