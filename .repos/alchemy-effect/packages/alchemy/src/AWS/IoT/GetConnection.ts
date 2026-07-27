import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetConnectionRequest extends iotdata.GetConnectionRequest {}

/**
 * Runtime binding for the IoT data-plane `GetConnection` operation (IAM
 * action `iot:GetConnection`).
 *
 * Binding to a client id filter grants `iot:GetConnection` on matching
 * MQTT client ARNs (or all clients when the filter is omitted) and returns
 * a callable that reads a client's connection state. Provide the
 * implementation with `Effect.provide(AWS.IoT.GetConnectionHttp)`.
 * @binding
 * @section MQTT Connections
 * @example Check a Device's Connectivity
 * ```typescript
 * const getConnection = yield* AWS.IoT.GetConnection("sensor-*");
 *
 * const { connected } = yield* getConnection({ clientId: "sensor-1" });
 * ```
 */
export interface GetConnection extends Binding.Service<
  GetConnection,
  "AWS.IoT.GetConnection",
  (
    clientIdFilter?: string,
  ) => Effect.Effect<
    (
      request: GetConnectionRequest,
    ) => Effect.Effect<
      iotdata.GetConnectionResponse,
      iotdata.GetConnectionError
    >
  >
> {}

export const GetConnection = Binding.Service<GetConnection>(
  "AWS.IoT.GetConnection",
);
