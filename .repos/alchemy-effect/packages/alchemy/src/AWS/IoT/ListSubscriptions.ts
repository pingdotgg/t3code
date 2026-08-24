import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListSubscriptionsRequest
  extends iotdata.ListSubscriptionsRequest {}

/**
 * Runtime binding for the IoT data-plane `ListSubscriptions` operation (IAM
 * action `iot:ListSubscriptions`).
 *
 * Binding to a client id filter grants `iot:ListSubscriptions` on matching
 * MQTT client ARNs (or all clients when the filter is omitted) and returns
 * a callable that lists the topic filters a connected client is subscribed
 * to. Provide the implementation with
 * `Effect.provide(AWS.IoT.ListSubscriptionsHttp)`.
 * @binding
 * @section MQTT Connections
 * @example Inspect a Device's Subscriptions
 * ```typescript
 * const listSubscriptions = yield* AWS.IoT.ListSubscriptions("sensor-*");
 *
 * const { subscriptions } = yield* listSubscriptions({
 *   clientId: "sensor-1",
 * });
 * ```
 */
export interface ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  "AWS.IoT.ListSubscriptions",
  (
    clientIdFilter?: string,
  ) => Effect.Effect<
    (
      request: ListSubscriptionsRequest,
    ) => Effect.Effect<
      iotdata.ListSubscriptionsResponse,
      iotdata.ListSubscriptionsError
    >
  >
> {}

export const ListSubscriptions = Binding.Service<ListSubscriptions>(
  "AWS.IoT.ListSubscriptions",
);
