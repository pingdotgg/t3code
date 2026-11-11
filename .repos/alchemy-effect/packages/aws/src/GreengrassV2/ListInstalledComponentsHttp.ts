import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListInstalledComponents } from "./ListInstalledComponents.ts";

export const ListInstalledComponentsHttp = Layer.effect(
  ListInstalledComponents,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListInstalledComponents",
    operation: greengrassv2.listInstalledComponents,
    actions: ["greengrass:ListInstalledComponents"],
  }),
);
