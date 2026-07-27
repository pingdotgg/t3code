import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListClientDevicesAssociatedWithCoreDevice } from "./ListClientDevicesAssociatedWithCoreDevice.ts";

export const ListClientDevicesAssociatedWithCoreDeviceHttp = Layer.effect(
  ListClientDevicesAssociatedWithCoreDevice,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListClientDevicesAssociatedWithCoreDevice",
    operation: greengrassv2.listClientDevicesAssociatedWithCoreDevice,
    actions: ["greengrass:ListClientDevicesAssociatedWithCoreDevice"],
  }),
);
