import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationStackHttpBinding } from "./BindingHttp.ts";
import { DescribeStacks } from "./DescribeStacks.ts";

export const DescribeStacksHttp = Layer.effect(
  DescribeStacks,
  makeCloudFormationStackHttpBinding({
    tag: "AWS.CloudFormation.DescribeStacks",
    operation: cloudformation.describeStacks,
    actions: ["cloudformation:DescribeStacks"],
  }),
);
