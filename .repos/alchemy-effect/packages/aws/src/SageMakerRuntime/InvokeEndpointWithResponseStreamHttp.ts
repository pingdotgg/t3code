import * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import * as Layer from "effect/Layer";
import { makeEndpointInvocationHttpBinding } from "./BindingHttp.ts";
import { InvokeEndpointWithResponseStream } from "./InvokeEndpointWithResponseStream.ts";

export const InvokeEndpointWithResponseStreamHttp = Layer.effect(
  InvokeEndpointWithResponseStream,
  makeEndpointInvocationHttpBinding({
    tag: "AWS.SageMakerRuntime.InvokeEndpointWithResponseStream",
    operation: sagemaker.invokeEndpointWithResponseStream,
    // The streaming operation authorizes against sagemaker:InvokeEndpoint
    // (there is no separate InvokeEndpointWithResponseStream IAM action).
    actions: ["sagemaker:InvokeEndpoint"],
  }),
);
