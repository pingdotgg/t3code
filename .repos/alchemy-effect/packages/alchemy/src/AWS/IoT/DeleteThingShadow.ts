import type * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Thing } from "./Thing.ts";

export interface DeleteThingShadowRequest extends Omit<
  iotdata.DeleteThingShadowRequest,
  "thingName"
> {}

/**
 * Runtime binding for the IoT data-plane `DeleteThingShadow` operation (IAM
 * action `iot:DeleteThingShadow`).
 *
 * Bind it to a {@link Thing} to delete the thing's device shadow — the thing
 * name is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.IoT.DeleteThingShadowHttp)`.
 * @binding
 * @section Device Shadows
 * @example Delete a Named Shadow
 * ```typescript
 * const deleteShadow = yield* AWS.IoT.DeleteThingShadow(thing);
 *
 * yield* deleteShadow({ shadowName: "telemetry" });
 * ```
 */
export interface DeleteThingShadow extends Binding.Service<
  DeleteThingShadow,
  "AWS.IoT.DeleteThingShadow",
  (
    thing: Thing,
  ) => Effect.Effect<
    (
      request?: DeleteThingShadowRequest,
    ) => Effect.Effect<
      iotdata.DeleteThingShadowResponse,
      iotdata.DeleteThingShadowError
    >
  >
> {}

export const DeleteThingShadow = Binding.Service<DeleteThingShadow>(
  "AWS.IoT.DeleteThingShadow",
);
