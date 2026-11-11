import * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import * as Layer from "effect/Layer";
import { makeEndpointInvocationHttpBinding } from "./BindingHttp.ts";
import { InvokeEndpointAsync } from "./InvokeEndpointAsync.ts";

export const InvokeEndpointAsyncHttp = Layer.effect(
  InvokeEndpointAsync,
  makeEndpointInvocationHttpBinding({
    tag: "AWS.SageMakerRuntime.InvokeEndpointAsync",
    operation: sagemaker.invokeEndpointAsync,
    actions: ["sagemaker:InvokeEndpointAsync"],
  }),
);
