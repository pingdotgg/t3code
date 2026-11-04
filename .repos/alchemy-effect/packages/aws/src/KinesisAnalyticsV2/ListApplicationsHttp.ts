import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsAccountHttpBinding } from "./BindingHttp.ts";
import { ListApplications } from "./ListApplications.ts";

export const ListApplicationsHttp = Layer.effect(
  ListApplications,
  makeKinesisAnalyticsAccountHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.ListApplications",
    operation: analytics.listApplications,
    actions: ["kinesisanalytics:ListApplications"],
  }),
);
