import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { RollbackApplication } from "./RollbackApplication.ts";

export const RollbackApplicationHttp = Layer.effect(
  RollbackApplication,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.RollbackApplication",
    operation: analytics.rollbackApplication,
    actions: ["kinesisanalytics:RollbackApplication"],
  }),
);
