import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationStackHttpBinding } from "./BindingHttp.ts";
import { DescribeStackEvents } from "./DescribeStackEvents.ts";

export const DescribeStackEventsHttp = Layer.effect(
  DescribeStackEvents,
  makeCloudFormationStackHttpBinding({
    tag: "AWS.CloudFormation.DescribeStackEvents",
    operation: cloudformation.describeStackEvents,
    actions: ["cloudformation:DescribeStackEvents"],
  }),
);
