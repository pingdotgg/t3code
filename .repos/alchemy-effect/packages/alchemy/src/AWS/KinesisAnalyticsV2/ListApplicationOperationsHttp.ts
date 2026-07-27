import * as analytics from "@distilled.cloud/aws/kinesis-analytics-v2";
import * as Layer from "effect/Layer";
import { makeKinesisAnalyticsHttpBinding } from "./BindingHttp.ts";
import { ListApplicationOperations } from "./ListApplicationOperations.ts";

export const ListApplicationOperationsHttp = Layer.effect(
  ListApplicationOperations,
  makeKinesisAnalyticsHttpBinding({
    tag: "AWS.KinesisAnalyticsV2.ListApplicationOperations",
    operation: analytics.listApplicationOperations,
    actions: ["kinesisanalytics:ListApplicationOperations"],
  }),
);
