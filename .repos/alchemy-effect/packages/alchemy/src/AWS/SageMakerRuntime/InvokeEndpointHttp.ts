import * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import * as Layer from "effect/Layer";
import { makeEndpointInvocationHttpBinding } from "./BindingHttp.ts";
import { InvokeEndpoint } from "./InvokeEndpoint.ts";

export const InvokeEndpointHttp = Layer.effect(
  InvokeEndpoint,
  makeEndpointInvocationHttpBinding({
    tag: "AWS.SageMakerRuntime.InvokeEndpoint",
    operation: sagemaker.invokeEndpoint,
    actions: ["sagemaker:InvokeEndpoint"],
  }),
);
