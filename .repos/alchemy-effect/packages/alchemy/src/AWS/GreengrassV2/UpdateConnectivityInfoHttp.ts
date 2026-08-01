import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { UpdateConnectivityInfo } from "./UpdateConnectivityInfo.ts";

export const UpdateConnectivityInfoHttp = Layer.effect(
  UpdateConnectivityInfo,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.UpdateConnectivityInfo",
    operation: greengrassv2.updateConnectivityInfo,
    // Connectivity info is stored in IoT Core; Greengrass writes it with the
    // caller's credentials (documented dependent action).
    actions: [
      "greengrass:UpdateConnectivityInfo",
      "iot:GetThingShadow",
      "iot:UpdateThingShadow",
    ],
  }),
);
