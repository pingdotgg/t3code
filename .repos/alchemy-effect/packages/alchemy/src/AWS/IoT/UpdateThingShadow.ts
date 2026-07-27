import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Thing } from "./Thing.ts";

export interface UpdateThingShadowRequest extends Omit<
  iotdata.UpdateThingShadowRequest,
  "thingName"
> {}

/**
 * Runtime binding for the IoT data-plane `UpdateThingShadow` operation (IAM
 * action `iot:UpdateThingShadow`).
 *
 * Bind it to a {@link Thing} to write the thing's device shadow — the thing
 * name is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.IoT.UpdateThingShadowHttp)`.
 * @binding
 * @section Device Shadows
 * @example Set Desired State
 * ```typescript
 * const updateShadow = yield* AWS.IoT.UpdateThingShadow(thing);
 *
 * yield* updateShadow({
 *   payload: JSON.stringify({ state: { desired: { led: "on" } } }),
 * });
 * ```
 *
 * @example Write a Named Shadow
 * ```typescript
 * yield* updateShadow({
 *   shadowName: "telemetry",
 *   payload: JSON.stringify({ state: { reported: { t: 22.5 } } }),
 * });
 * ```
 */
export interface UpdateThingShadow extends Binding.Service<
  UpdateThingShadow,
  "AWS.IoT.UpdateThingShadow",
  (
    thing: Thing,
  ) => Effect.Effect<
    (
      request: UpdateThingShadowRequest,
    ) => Effect.Effect<
      iotdata.UpdateThingShadowResponse,
      iotdata.UpdateThingShadowError
    >
  >
> {}

export const UpdateThingShadow = Binding.Service<UpdateThingShadow>(
  "AWS.IoT.UpdateThingShadow",
);
