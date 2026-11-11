import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";
import type { MetricStream } from "./MetricStream.ts";
import { StartMetricStreams } from "./StartMetricStreams.ts";

export const StartMetricStreamsHttp = Layer.effect(
  StartMetricStreams,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.StartMetricStreams",
    operation: cloudwatch.startMetricStreams,
    action: "cloudwatch:StartMetricStreams",
    namesKey: "Names",
    name: (metricStream: MetricStream) => metricStream.metricStreamName,
    arn: (metricStream: MetricStream) => metricStream.metricStreamArn,
  }),
);
