import * as ga from "@distilled.cloud/aws/global-accelerator";
import * as Layer from "effect/Layer";
import { makeGaAcceleratorHttpBinding } from "./BindingHttp.ts";
import { DescribeAccelerator } from "./DescribeAccelerator.ts";

export const DescribeAcceleratorHttp = Layer.effect(
  DescribeAccelerator,
  makeGaAcceleratorHttpBinding({
    tag: "AWS.GlobalAccelerator.DescribeAccelerator",
    operation: ga.describeAccelerator,
    actions: ["globalaccelerator:DescribeAccelerator"],
  }),
);
