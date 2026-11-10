import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { GetMetricWidgetImage } from "./GetMetricWidgetImage.ts";

export const GetMetricWidgetImageHttp = Layer.effect(
  GetMetricWidgetImage,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.GetMetricWidgetImage",
    operation: cloudwatch.getMetricWidgetImage,
    actions: ["cloudwatch:GetMetricWidgetImage"],
  }),
);
