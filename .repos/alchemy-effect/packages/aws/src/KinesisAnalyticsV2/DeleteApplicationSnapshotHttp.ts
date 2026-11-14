import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { DeleteApplicationSnapshot } from "./DeleteApplicationSnapshot.ts";

export const DeleteApplicationSnapshotHttp = Layer.effect(
  DeleteApplicationSnapshot,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.DeleteApplicationSnapshot",
    operation: analytics.deleteApplicationSnapshot,
    actions: ["kinesisanalytics:DeleteApplicationSnapshot"],
  }),
);
