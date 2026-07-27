import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WirelessGateway } from "./WirelessGateway.ts";

/**
 * Request for {@link GetWirelessGatewayStatistics}. The bound gateway's id
 * is injected automatically, leaving nothing else to supply.
 */
export interface GetWirelessGatewayStatisticsRequest extends Omit<
  iotw.GetWirelessGatewayStatisticsRequest,
  "WirelessGatewayId"
> {}

/**
 * Runtime binding for `iotwireless:GetWirelessGatewayStatistics` — read the
 * bound wireless gateway's operating information (connection status, last
 * uplink time) from a deployed Lambda or Task.
 *
 * @binding
 * @section Reading Gateway Statistics
 * Provide the `GetWirelessGatewayStatisticsHttp` implementation layer on
 * the Function effect, bind the gateway in the init phase, then call the
 * returned client at runtime.
 *
 * @example Check the Gateway's Connection Status
 * ```typescript
 * // init
 * const getStats = yield* AWS.IoTWireless.GetWirelessGatewayStatistics(gateway);
 *
 * // runtime
 * const stats = yield* getStats();
 * const online = stats.ConnectionStatus === "Connected";
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.GetWirelessGatewayStatisticsHttp))
 * ```
 */
export interface GetWirelessGatewayStatistics extends Binding.Service<
  GetWirelessGatewayStatistics,
  "AWS.IoTWireless.GetWirelessGatewayStatistics",
  (
    gateway: WirelessGateway,
  ) => Effect.Effect<
    (
      request?: GetWirelessGatewayStatisticsRequest,
    ) => Effect.Effect<
      iotw.GetWirelessGatewayStatisticsResponse,
      iotw.GetWirelessGatewayStatisticsError
    >
  >
> {}
export const GetWirelessGatewayStatistics =
  Binding.Service<GetWirelessGatewayStatistics>(
    "AWS.IoTWireless.GetWirelessGatewayStatistics",
  );
