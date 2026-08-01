import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `iotwireless:GetPositionEstimate` — resolve an
 * estimated position (as a GeoJSON payload stream) from raw measurement
 * data — WiFi access points, cell towers, GNSS scans, or an IP address —
 * using third-party solvers, from a deployed Lambda or Task. Account-level:
 * it is not tied to any registered device.
 *
 * @binding
 * @section Estimating a Position
 * Provide the `GetPositionEstimateHttp` implementation layer on the
 * Function effect, bind the capability in the init phase, then call the
 * returned client at runtime. The `GeoJsonPayload` is a byte `Stream` —
 * decode it with `Stream.mkString(Stream.decodeText(...))`.
 *
 * @example Solve a Position from WiFi Scans
 * ```typescript
 * // init
 * const estimate = yield* AWS.IoTWireless.GetPositionEstimate();
 *
 * // runtime
 * const { GeoJsonPayload } = yield* estimate({
 *   WiFiAccessPoints: [
 *     { MacAddress: "A0:EC:F9:1E:32:C1", Rss: -66 },
 *     { MacAddress: "A0:EC:F9:15:72:5E", Rss: -72 },
 *   ],
 * });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.GetPositionEstimateHttp))
 * ```
 */
export interface GetPositionEstimate extends Binding.Service<
  GetPositionEstimate,
  "AWS.IoTWireless.GetPositionEstimate",
  () => Effect.Effect<
    (
      request: iotw.GetPositionEstimateRequest,
    ) => Effect.Effect<
      iotw.GetPositionEstimateResponse,
      iotw.GetPositionEstimateError
    >
  >
> {}
export const GetPositionEstimate = Binding.Service<GetPositionEstimate>(
  "AWS.IoTWireless.GetPositionEstimate",
);
