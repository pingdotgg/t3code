import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";

/**
 * Request for {@link GetResourcePosition}. The bound device's id and the
 * `WirelessDevice` resource type are injected automatically, leaving
 * nothing else to supply.
 */
export interface GetResourcePositionRequest extends Omit<
  iotw.GetResourcePositionRequest,
  "ResourceIdentifier" | "ResourceType"
> {}

/**
 * Runtime binding for `iotwireless:GetResourcePosition` — read the bound
 * wireless device's position (WGS84, returned as a GeoJSON payload stream)
 * from a deployed Lambda or Task.
 *
 * @binding
 * @section Reading Device Position
 * Provide the `GetResourcePositionHttp` implementation layer on the
 * Function effect, bind the device in the init phase, then call the
 * returned client at runtime. The `GeoJsonPayload` is a byte `Stream` —
 * decode it to a string with `Stream.mkString(Stream.decodeText(...))`.
 *
 * @example Read the Device's GeoJSON Position
 * ```typescript
 * // init
 * const getPosition = yield* AWS.IoTWireless.GetResourcePosition(device);
 *
 * // runtime
 * const { GeoJsonPayload } = yield* getPosition();
 * const geoJson = GeoJsonPayload === undefined
 *   ? undefined
 *   : yield* Stream.mkString(Stream.decodeText(GeoJsonPayload));
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.GetResourcePositionHttp))
 * ```
 */
export interface GetResourcePosition extends Binding.Service<
  GetResourcePosition,
  "AWS.IoTWireless.GetResourcePosition",
  (
    device: WirelessDevice,
  ) => Effect.Effect<
    (
      request?: GetResourcePositionRequest,
    ) => Effect.Effect<
      iotw.GetResourcePositionResponse,
      iotw.GetResourcePositionError
    >
  >
> {}
export const GetResourcePosition = Binding.Service<GetResourcePosition>(
  "AWS.IoTWireless.GetResourcePosition",
);
