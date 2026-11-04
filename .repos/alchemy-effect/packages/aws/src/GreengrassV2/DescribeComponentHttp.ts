import * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import * as Layer from "effect/Layer";
import { makeGreengrassComponentHttpBinding } from "./BindingHttp.ts";
import { DescribeComponent } from "./DescribeComponent.ts";

export const DescribeComponentHttp = Layer.effect(
  DescribeComponent,
  makeGreengrassComponentHttpBinding({
    tag: "AWS.GreengrassV2.DescribeComponent",
    operation: greengrassv2.describeComponent,
    actions: ["greengrass:DescribeComponent"],
  }),
);
