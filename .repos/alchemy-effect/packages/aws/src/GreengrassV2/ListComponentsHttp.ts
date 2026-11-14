import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListComponents } from "./ListComponents.ts";

export const ListComponentsHttp = Layer.effect(
  ListComponents,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListComponents",
    operation: greengrassv2.listComponents,
    actions: ["greengrass:ListComponents"],
  }),
);
