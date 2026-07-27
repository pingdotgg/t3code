import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListInternetEventsRequest extends im.ListInternetEventsInput {}

/**
 * Runtime binding for `internetmonitor:ListInternetEvents` — list the global
 * internet events (performance or availability issues at client locations)
 * from the outages map Internet Monitor publishes for all AWS customers.
 * Internet events are account-level; no monitor is required.
 *
 * Provide `InternetMonitor.ListInternetEventsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Internet Events
 * @example List Active Internet Events
 * ```typescript
 * // init — grants internetmonitor:ListInternetEvents
 * const listInternetEvents = yield* AWS.InternetMonitor.ListInternetEvents();
 *
 * // runtime
 * const { InternetEvents } = yield* listInternetEvents({
 *   EventStatus: "ACTIVE",
 * });
 * ```
 */
export interface ListInternetEvents extends Binding.Service<
  ListInternetEvents,
  "AWS.InternetMonitor.ListInternetEvents",
  () => Effect.Effect<
    (
      request?: ListInternetEventsRequest,
    ) => Effect.Effect<im.ListInternetEventsOutput, im.ListInternetEventsError>
  >
> {}

export const ListInternetEvents = Binding.Service<ListInternetEvents>(
  "AWS.InternetMonitor.ListInternetEvents",
);
