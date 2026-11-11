import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Layer from "effect/Layer";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";
import type { Dashboard } from "./Dashboard.ts";
import { GetDashboard } from "./GetDashboard.ts";

export const GetDashboardHttp = Layer.effect(
  GetDashboard,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.GetDashboard",
    operation: cloudwatch.getDashboard,
    actions: ["cloudwatch:GetDashboard"],
    requestKey: "DashboardName",
    identifier: (dashboard: Dashboard) => dashboard.dashboardName,
    resourceArn: (dashboard: Dashboard) => dashboard.dashboardArn,
  }),
);
