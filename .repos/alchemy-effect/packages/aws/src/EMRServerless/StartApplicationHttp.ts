import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { StartApplication } from "./StartApplication.ts";

export const StartApplicationHttp = Layer.effect(
  StartApplication,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.StartApplication",
    operation: emr.startApplication,
    actions: ["emr-serverless:StartApplication"],
  }),
);
