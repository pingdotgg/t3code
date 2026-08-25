import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListCoreDevices } from "./ListCoreDevices.ts";

export const ListCoreDevicesHttp = Layer.effect(
  ListCoreDevices,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListCoreDevices",
    operation: greengrassv2.listCoreDevices,
    actions: ["greengrass:ListCoreDevices"],
  }),
);
