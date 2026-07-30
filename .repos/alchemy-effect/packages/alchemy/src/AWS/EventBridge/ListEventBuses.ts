import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListEventBusesRequest
  extends eventbridge.ListEventBusesRequest {}

/**
 * Lists the event buses in the account (`events:ListEventBuses`).
 *
 * An account-level operation — bind it with no resource argument. Provide the
 * `ListEventBusesHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Listing Event Buses
 * @example List All Event Buses
 * ```typescript
 * // init — no resource argument (provide AWS.EventBridge.ListEventBusesHttp on the Function)
 * const listEventBuses = yield* AWS.EventBridge.ListEventBuses();
 *
 * // runtime — list buses, optionally filtered by name prefix
 * const { EventBuses } = yield* listEventBuses({ NamePrefix: "my-app" });
 * ```
 */
export interface ListEventBuses extends Binding.Service<
  ListEventBuses,
  "AWS.EventBridge.ListEventBuses",
  () => Effect.Effect<
    (
      request?: ListEventBusesRequest,
    ) => Effect.Effect<
      eventbridge.ListEventBusesResponse,
      eventbridge.ListEventBusesError
    >
  >
> {}
export const ListEventBuses = Binding.Service<ListEventBuses>(
  "AWS.EventBridge.ListEventBuses",
);
