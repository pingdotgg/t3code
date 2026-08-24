import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Thing } from "./Thing.ts";

export interface GetThingShadowRequest extends Omit<
  iotdata.GetThingShadowRequest,
  "thingName"
> {}

/**
 * Runtime binding for the IoT data-plane `GetThingShadow` operation (IAM
 * action `iot:GetThingShadow`).
 *
 * Bind it to a {@link Thing} to read the thing's device shadow — the thing
 * name is injected automatically. The response `payload` is a byte Stream;
 * decode it with `Stream.decodeText` + `Stream.mkString`. Provide the
 * implementation with `Effect.provide(AWS.IoT.GetThingShadowHttp)`.
 * @binding
 * @section Device Shadows
 * @example Read the Classic Shadow
 * ```typescript
 * const getShadow = yield* AWS.IoT.GetThingShadow(thing);
 *
 * const state = yield* getShadow().pipe(
 *   Effect.flatMap((result) =>
 *     Stream.mkString(Stream.decodeText(result.payload!)),
 *   ),
 * );
 * ```
 *
 * @example Read a Named Shadow
 * ```typescript
 * const result = yield* getShadow({ shadowName: "telemetry" });
 * ```
 */
export interface GetThingShadow extends Binding.Service<
  GetThingShadow,
  "AWS.IoT.GetThingShadow",
  (
    thing: Thing,
  ) => Effect.Effect<
    (
      request?: GetThingShadowRequest,
    ) => Effect.Effect<
      iotdata.GetThingShadowResponse,
      iotdata.GetThingShadowError
    >
  >
> {}

export const GetThingShadow = Binding.Service<GetThingShadow>(
  "AWS.IoT.GetThingShadow",
);
