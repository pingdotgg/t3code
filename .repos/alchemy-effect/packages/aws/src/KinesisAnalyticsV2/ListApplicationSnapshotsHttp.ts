import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { ListApplicationSnapshots } from "./ListApplicationSnapshots.ts";

export const ListApplicationSnapshotsHttp = Layer.effect(
  ListApplicationSnapshots,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.ListApplicationSnapshots",
    operation: analytics.listApplicationSnapshots,
    actions: ["kinesisanalytics:ListApplicationSnapshots"],
  }),
);
