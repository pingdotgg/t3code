import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Monitor } from "./Monitor.ts";

export interface ListHealthEventsRequest extends Omit<
  im.ListHealthEventsInput,
  "MonitorName"
> {}

/**
 * Runtime binding for `internetmonitor:ListHealthEvents` — list the health
 * events Internet Monitor created for the bound {@link Monitor}; the monitor
 * name is injected automatically.
 *
 * Provide `InternetMonitor.ListHealthEventsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Health Events
 * @example List Active Health Events
 * ```typescript
 * // init — grants internetmonitor:ListHealthEvents on the monitor
 * const listHealthEvents = yield* AWS.InternetMonitor.ListHealthEvents(monitor);
 *
 * // runtime
 * const { HealthEvents } = yield* listHealthEvents({ EventStatus: "ACTIVE" });
 * ```
 */
export interface ListHealthEvents extends Binding.Service<
  ListHealthEvents,
  "AWS.InternetMonitor.ListHealthEvents",
  (
    monitor: Monitor,
  ) => Effect.Effect<
    (
      request?: ListHealthEventsRequest,
    ) => Effect.Effect<im.ListHealthEventsOutput, im.ListHealthEventsError>
  >
> {}

export const ListHealthEvents = Binding.Service<ListHealthEvents>(
  "AWS.InternetMonitor.ListHealthEvents",
);
