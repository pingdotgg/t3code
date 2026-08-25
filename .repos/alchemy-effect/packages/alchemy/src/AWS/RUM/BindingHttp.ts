import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { AppMonitor } from "./AppMonitor.ts";

/**
 * Shared scaffolding for CloudWatch RUM HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over the builder below
 * (or reuses {@link bindRumAppMonitorPolicy} when the runtime callable needs
 * bespoke request shaping, like `PutRumEvents` injecting the monitor id and
 * details). Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Deploy-time half shared by every app-monitor-scoped RUM binding: resolve
 * the hosting Function and grant `actions` on the monitor's ARN. A no-op
 * inside the deployed runtime.
 */
export const bindRumAppMonitorPolicy = (options: {
  tag: string;
  monitor: AppMonitor;
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isBindingHost(host)) {
        yield* host.bind`Allow(${host}, ${options.tag}(${options.monitor}))`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: [options.monitor.appMonitorArn],
            },
          ],
        });
      }
    }
  });

/**
 * Build the impl Effect for an operation scoped to a single bound
 * {@link AppMonitor} and addressed by monitor name. The runtime callable
 * injects the monitor's name as the request's `Name`; the deploy-time half
 * grants `actions` on the monitor ARN.
 */
export const makeRumAppMonitorHttpBinding = <
  I extends { Name: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.RUM.GetAppMonitorData`. */
  tag: string;
  /** The distilled operation; `Name` is injected from the monitor. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the monitor ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (monitor: AppMonitor) {
      const Name = yield* monitor.appMonitorName;
      yield* bindRumAppMonitorPolicy({
        tag: options.tag,
        monitor,
        actions: options.actions,
      });
      return Effect.fn(`${options.tag}(${monitor.LogicalId})`)(function* (
        request: Omit<I, "Name">,
      ) {
        return yield* op({ ...request, Name: yield* Name } as I);
      });
    });
  });
