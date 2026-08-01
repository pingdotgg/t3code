import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { PutMetricData } from "./PutMetricData.ts";

export const PutMetricDataHttp = Layer.effect(
  PutMetricData,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.PutMetricData",
    operation: cloudwatch.putMetricData,
    actions: ["cloudwatch:PutMetricData"],
  }),
);
