import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { DescribeAnomalyDetectors } from "./DescribeAnomalyDetectors.ts";

export const DescribeAnomalyDetectorsHttp = Layer.effect(
  DescribeAnomalyDetectors,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.DescribeAnomalyDetectors",
    operation: cloudwatch.describeAnomalyDetectors,
    actions: ["cloudwatch:DescribeAnomalyDetectors"],
  }),
);
