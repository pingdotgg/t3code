import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { ListApplicationVersions } from "./ListApplicationVersions.ts";

export const ListApplicationVersionsHttp = Layer.effect(
  ListApplicationVersions,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.ListApplicationVersions",
    operation: analytics.listApplicationVersions,
    actions: ["kinesisanalytics:ListApplicationVersions"],
  }),
);
