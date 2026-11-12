import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { CancelJobRun } from "./CancelJobRun.ts";

export const CancelJobRunHttp = Layer.effect(
  CancelJobRun,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.CancelJobRun",
    operation: emr.cancelJobRun,
    actions: ["emr-serverless:CancelJobRun"],
    subresources: ["/jobruns/*"],
  }),
);
