import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { ListMetrics } from "./ListMetrics.ts";

export const ListMetricsHttp = Layer.effect(
  ListMetrics,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.ListMetrics",
    operation: cloudwatch.listMetrics,
    actions: ["cloudwatch:ListMetrics"],
  }),
);
