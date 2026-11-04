import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { DescribeApplicationOperation } from "./DescribeApplicationOperation.ts";

export const DescribeApplicationOperationHttp = Layer.effect(
  DescribeApplicationOperation,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.DescribeApplicationOperation",
    operation: analytics.describeApplicationOperation,
    actions: ["kinesisanalytics:DescribeApplicationOperation"],
  }),
);
