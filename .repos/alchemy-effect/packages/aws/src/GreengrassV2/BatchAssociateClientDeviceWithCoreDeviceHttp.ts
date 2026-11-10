import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { BatchAssociateClientDeviceWithCoreDevice } from "./BatchAssociateClientDeviceWithCoreDevice.ts";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";

export const BatchAssociateClientDeviceWithCoreDeviceHttp = Layer.effect(
  BatchAssociateClientDeviceWithCoreDevice,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.BatchAssociateClientDeviceWithCoreDevice",
    operation: greengrassv2.batchAssociateClientDeviceWithCoreDevice,
    actions: ["greengrass:BatchAssociateClientDeviceWithCoreDevice"],
  }),
);
