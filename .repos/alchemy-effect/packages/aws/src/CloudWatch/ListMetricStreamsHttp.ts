import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { ListMetricStreams } from "./ListMetricStreams.ts";

export const ListMetricStreamsHttp = Layer.effect(
  ListMetricStreams,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.ListMetricStreams",
    operation: cloudwatch.listMetricStreams,
    actions: ["cloudwatch:ListMetricStreams"],
  }),
);
