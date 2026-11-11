import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Layer from "effect/Layer";
import { makeCloudFormationStackHttpBinding } from "./BindingHttp.ts";
import { SignalResource } from "./SignalResource.ts";

export const SignalResourceHttp = Layer.effect(
  SignalResource,
  makeCloudFormationStackHttpBinding({
    tag: "AWS.CloudFormation.SignalResource",
    operation: cloudformation.signalResource,
    actions: ["cloudformation:SignalResource"],
  }),
);
