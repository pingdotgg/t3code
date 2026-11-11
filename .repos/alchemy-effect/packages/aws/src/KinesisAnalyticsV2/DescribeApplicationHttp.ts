import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { DescribeApplication } from "./DescribeApplication.ts";

export const DescribeApplicationHttp = Layer.effect(
  DescribeApplication,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.DescribeApplication",
    operation: analytics.describeApplication,
    actions: ["kinesisanalytics:DescribeApplication"],
  }),
);
