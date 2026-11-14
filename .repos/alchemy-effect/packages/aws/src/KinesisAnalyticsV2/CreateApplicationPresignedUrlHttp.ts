import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { CreateApplicationPresignedUrl } from "./CreateApplicationPresignedUrl.ts";

export const CreateApplicationPresignedUrlHttp = Layer.effect(
  CreateApplicationPresignedUrl,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.CreateApplicationPresignedUrl",
    operation: analytics.createApplicationPresignedUrl,
    actions: ["kinesisanalytics:CreateApplicationPresignedUrl"],
  }),
);
