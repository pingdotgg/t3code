import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Layer from "effect/Layer";
import { makeIotThingHttpBinding } from "./BindingHttp.ts";
import { GetThingShadow } from "./GetThingShadow.ts";

/**
 * HTTP implementation of the {@link GetThingShadow} capability — grants
 * `iot:GetThingShadow` on the thing ARN and calls the IoT data-plane
 * `GetThingShadow` API.
 */
export const GetThingShadowHttp = Layer.effect(
  GetThingShadow,
  makeIotThingHttpBinding({
    tag: "AWS.IoT.GetThingShadow",
    operation: iotdata.getThingShadow,
    actions: ["iot:GetThingShadow"],
  }),
);
