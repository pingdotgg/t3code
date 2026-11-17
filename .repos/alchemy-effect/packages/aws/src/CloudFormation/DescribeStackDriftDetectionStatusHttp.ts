import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeStackDriftDetectionStatus } from "./DescribeStackDriftDetectionStatus.ts";

export const DescribeStackDriftDetectionStatusHttp = Layer.effect(
  DescribeStackDriftDetectionStatus,
  makeCloudFormationAccountHttpBinding({
    tag: "AWS.CloudFormation.DescribeStackDriftDetectionStatus",
    operation: cloudformation.describeStackDriftDetectionStatus,
    actions: ["cloudformation:DescribeStackDriftDetectionStatus"],
  }),
);
