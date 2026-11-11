import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { GetMetricStatistics } from "./GetMetricStatistics.ts";

export const GetMetricStatisticsHttp = Layer.effect(
  GetMetricStatistics,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.GetMetricStatistics",
    operation: cloudwatch.getMetricStatistics,
    actions: ["cloudwatch:GetMetricStatistics"],
  }),
);
