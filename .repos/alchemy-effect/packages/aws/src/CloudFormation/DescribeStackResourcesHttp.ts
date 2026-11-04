import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationStackHttpBinding } from "./BindingHttp.ts";
import { DescribeStackResources } from "./DescribeStackResources.ts";

export const DescribeStackResourcesHttp = Layer.effect(
  DescribeStackResources,
  makeCloudFormationStackHttpBinding({
    tag: "AWS.CloudFormation.DescribeStackResources",
    operation: cloudformation.describeStackResources,
    actions: ["cloudformation:DescribeStackResources"],
  }),
);
