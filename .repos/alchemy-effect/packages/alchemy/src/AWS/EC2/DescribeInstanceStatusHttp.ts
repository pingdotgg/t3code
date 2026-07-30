import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DescribeInstanceStatus } from "./DescribeInstanceStatus.ts";

export const DescribeInstanceStatusHttp = Layer.effect(
  DescribeInstanceStatus,
  makeInstanceHttpBinding({
    tag: "AWS.EC2.DescribeInstanceStatus",
    operation: ec2.describeInstanceStatus,
    actions: ["ec2:DescribeInstanceStatus"],
    requestKey: "InstanceIds",
    resource: "*",
  }),
);
