import * as ga from "@distilled.cloud/aws/global-accelerator";
import * as Layer from "effect/Layer";
import { makeGaEndpointGroupHttpBinding } from "./BindingHttp.ts";
import { DescribeEndpointGroup } from "./DescribeEndpointGroup.ts";

export const DescribeEndpointGroupHttp = Layer.effect(
  DescribeEndpointGroup,
  makeGaEndpointGroupHttpBinding({
    tag: "AWS.GlobalAccelerator.DescribeEndpointGroup",
    operation: ga.describeEndpointGroup,
    actions: ["globalaccelerator:DescribeEndpointGroup"],
  }),
);
