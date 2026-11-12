import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { StopApplication } from "./StopApplication.ts";

export const StopApplicationHttp = Layer.effect(
  StopApplication,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.StopApplication",
    operation: emr.stopApplication,
    actions: ["emr-serverless:StopApplication"],
  }),
);
