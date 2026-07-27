import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { DescribeApplicationSnapshot } from "./DescribeApplicationSnapshot.ts";

export const DescribeApplicationSnapshotHttp = Layer.effect(
  DescribeApplicationSnapshot,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.DescribeApplicationSnapshot",
    operation: analytics.describeApplicationSnapshot,
    actions: ["kinesisanalytics:DescribeApplicationSnapshot"],
  }),
);
