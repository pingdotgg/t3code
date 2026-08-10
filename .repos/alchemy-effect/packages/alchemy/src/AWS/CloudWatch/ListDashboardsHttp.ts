import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchAccountHttpBinding } from "./BindingHttp.ts";
import { ListDashboards } from "./ListDashboards.ts";

export const ListDashboardsHttp = Layer.effect(
  ListDashboards,
  makeCloudWatchAccountHttpBinding({
    tag: "AWS.CloudWatch.ListDashboards",
    operation: cloudwatch.listDashboards,
    actions: ["cloudwatch:ListDashboards"],
  }),
);
