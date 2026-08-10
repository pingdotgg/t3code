import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { GetConnectivityInfo } from "./GetConnectivityInfo.ts";

export const GetConnectivityInfoHttp = Layer.effect(
  GetConnectivityInfo,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.GetConnectivityInfo",
    operation: greengrassv2.getConnectivityInfo,
    // Connectivity info is stored in IoT Core; Greengrass reads it with the
    // caller's credentials (documented dependent action).
    actions: ["greengrass:GetConnectivityInfo", "iot:GetThingShadow"],
  }),
);
