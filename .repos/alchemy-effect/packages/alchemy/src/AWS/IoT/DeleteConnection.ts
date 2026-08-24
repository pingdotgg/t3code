import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DeleteConnectionRequest
  extends iotdata.DeleteConnectionRequest {}

/**
 * Runtime binding for the IoT data-plane `DeleteConnection` operation (IAM
 * action `iot:DeleteConnection`).
 *
 * Binding to a client id filter grants `iot:DeleteConnection` on matching
 * MQTT client ARNs (or all clients when the filter is omitted) and returns
 * a callable that force-disconnects a connected client, optionally cleaning
 * its session state. Provide the implementation with
 * `Effect.provide(AWS.IoT.DeleteConnectionHttp)`.
 * @binding
 * @section MQTT Connections
 * @example Kick a Device off the Broker
 * ```typescript
 * const deleteConnection = yield* AWS.IoT.DeleteConnection("sensor-*");
 *
 * yield* deleteConnection({ clientId: "sensor-1", cleanSession: true });
 * ```
 */
export interface DeleteConnection extends Binding.Service<
  DeleteConnection,
  "AWS.IoT.DeleteConnection",
  (
    clientIdFilter?: string,
  ) => Effect.Effect<
    (
      request: DeleteConnectionRequest,
    ) => Effect.Effect<
      iotdata.DeleteConnectionResponse,
      iotdata.DeleteConnectionError
    >
  >
> {}

export const DeleteConnection = Binding.Service<DeleteConnection>(
  "AWS.IoT.DeleteConnection",
);
