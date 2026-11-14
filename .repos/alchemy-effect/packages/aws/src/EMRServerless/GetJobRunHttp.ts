import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { GetJobRun } from "./GetJobRun.ts";

export const GetJobRunHttp = Layer.effect(
  GetJobRun,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.GetJobRun",
    operation: emr.getJobRun,
    actions: ["emr-serverless:GetJobRun"],
    subresources: ["/jobruns/*"],
  }),
);
