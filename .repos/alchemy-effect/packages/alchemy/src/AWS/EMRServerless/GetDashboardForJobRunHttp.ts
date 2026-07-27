import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { GetDashboardForJobRun } from "./GetDashboardForJobRun.ts";

export const GetDashboardForJobRunHttp = Layer.effect(
  GetDashboardForJobRun,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.GetDashboardForJobRun",
    operation: emr.getDashboardForJobRun,
    actions: ["emr-serverless:GetDashboardForJobRun"],
    subresources: ["/jobruns/*"],
  }),
);
