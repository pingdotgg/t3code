import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";
import { GetMetricStream } from "./GetMetricStream.ts";
import type { MetricStream } from "./MetricStream.ts";

export const GetMetricStreamHttp = Layer.effect(
  GetMetricStream,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.GetMetricStream",
    operation: cloudwatch.getMetricStream,
    actions: ["cloudwatch:GetMetricStream"],
    requestKey: "Name",
    identifier: (metricStream: MetricStream) => metricStream.metricStreamName,
    resourceArn: (metricStream: MetricStream) => metricStream.metricStreamArn,
  }),
);
