import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { GetMetricData } from "./GetMetricData.ts";

export const GetMetricDataHttp = Layer.effect(
  GetMetricData,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.GetMetricData",
    operation: cloudwatch.getMetricData,
    actions: ["cloudwatch:GetMetricData"],
  }),
);
