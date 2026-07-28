import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";

/**
 * Request for {@link GetWirelessDeviceStatistics}. The bound device's id is
 * injected automatically, leaving nothing else to supply.
 */
export interface GetWirelessDeviceStatisticsRequest extends Omit<
  iotw.GetWirelessDeviceStatisticsRequest,
  "WirelessDeviceId"
> {}

/**
 * Runtime binding for `iotwireless:GetWirelessDeviceStatistics` — read the
 * bound wireless device's operating information (last uplink time, RSSI/SNR
 * gateway metadata, battery level, device state) from a deployed Lambda or
 * Task.
 *
 * @binding
 * @section Reading Device Statistics
 * Provide the `GetWirelessDeviceStatisticsHttp` implementation layer on the
 * Function effect, bind the device in the init phase, then call the
 * returned client at runtime.
 *
 * @example Check When the Device Last Reported
 * ```typescript
 * // init
 * const getStats = yield* AWS.IoTWireless.GetWirelessDeviceStatistics(device);
 *
 * // runtime
 * const stats = yield* getStats();
 * const lastSeen = stats.LastUplinkReceivedAt;
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.GetWirelessDeviceStatisticsHttp))
 * ```
 */
export interface GetWirelessDeviceStatistics extends Binding.Service<
  GetWirelessDeviceStatistics,
  "AWS.IoTWireless.GetWirelessDeviceStatistics",
  (
    device: WirelessDevice,
  ) => Effect.Effect<
    (
      request?: GetWirelessDeviceStatisticsRequest,
    ) => Effect.Effect<
      iotw.GetWirelessDeviceStatisticsResponse,
      iotw.GetWirelessDeviceStatisticsError
    >
  >
> {}
export const GetWirelessDeviceStatistics =
  Binding.Service<GetWirelessDeviceStatistics>(
    "AWS.IoTWireless.GetWirelessDeviceStatistics",
  );
