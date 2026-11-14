import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassAccountHttpBinding } from "./BindingHttp.ts";
import { ListComponentVersions } from "./ListComponentVersions.ts";

export const ListComponentVersionsHttp = Layer.effect(
  ListComponentVersions,
  makeGreengrassAccountHttpBinding({
    tag: "AWS.GreengrassV2.ListComponentVersions",
    operation: greengrassv2.listComponentVersions,
    actions: ["greengrass:ListComponentVersions"],
  }),
);
