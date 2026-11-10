import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";
import type { MetricStream } from "./MetricStream.ts";
import { StopMetricStreams } from "./StopMetricStreams.ts";

export const StopMetricStreamsHttp = Layer.effect(
  StopMetricStreams,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.StopMetricStreams",
    operation: cloudwatch.stopMetricStreams,
    action: "cloudwatch:StopMetricStreams",
    namesKey: "Names",
    name: (metricStream: MetricStream) => metricStream.metricStreamName,
    arn: (metricStream: MetricStream) => metricStream.metricStreamArn,
  }),
);
