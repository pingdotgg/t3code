import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotThingHttpBinding } from "./BindingHttp.ts";
import { UpdateThingShadow } from "./UpdateThingShadow.ts";

/**
 * HTTP implementation of the {@link UpdateThingShadow} capability — grants
 * `iot:UpdateThingShadow` on the thing ARN and calls the IoT data-plane
 * `UpdateThingShadow` API.
 */
export const UpdateThingShadowHttp = Layer.effect(
  UpdateThingShadow,
  makeIotThingHttpBinding({
    tag: "AWS.IoT.UpdateThingShadow",
    operation: iotdata.updateThingShadow,
    actions: ["iot:UpdateThingShadow"],
  }),
);
