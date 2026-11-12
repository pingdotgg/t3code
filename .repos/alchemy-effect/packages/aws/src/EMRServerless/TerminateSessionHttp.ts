import * as emr from "@distilled.cloud/aws/emr-serverless";
import * as Layer from "effect/Layer";
import { makeEmrServerlessHttpBinding } from "./BindingHttp.ts";
import { TerminateSession } from "./TerminateSession.ts";

export const TerminateSessionHttp = Layer.effect(
  TerminateSession,
  makeEmrServerlessHttpBinding({
    tag: "AWS.EMRServerless.TerminateSession",
    operation: emr.terminateSession,
    actions: ["emr-serverless:TerminateSession"],
    subresources: ["/sessions/*"],
  }),
);
