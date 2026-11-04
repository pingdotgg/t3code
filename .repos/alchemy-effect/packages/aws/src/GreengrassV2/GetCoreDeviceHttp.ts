import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { GetCoreDevice } from "./GetCoreDevice.ts";

export const GetCoreDeviceHttp = Layer.effect(
  GetCoreDevice,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.GetCoreDevice",
    operation: greengrassv2.getCoreDevice,
    // Core devices are IoT things; Greengrass authorizes the IoT-side lookup
    // with the caller's credentials before resolving the device (observed
    // "not authorized to call Iot Core services for thing" without it).
    actions: ["greengrass:GetCoreDevice", "iot:DescribeThing"],
  }),
);
