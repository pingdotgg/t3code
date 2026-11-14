import * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import * as Layer from "effect/Layer";
import { makeModelScopedHttpBinding } from "./BindingHttp.ts";
import { InvokeModelWithResponseStream } from "./InvokeModelWithResponseStream.ts";

export const InvokeModelWithResponseStreamHttp = Layer.effect(
  InvokeModelWithResponseStream,
  makeModelScopedHttpBinding({
    tag: "AWS.Bedrock.InvokeModelWithResponseStream",
    operation: bedrock.invokeModelWithResponseStream,
    // Streaming operations authorize against this action, not
    // bedrock:InvokeModel.
    actions: ["bedrock:InvokeModelWithResponseStream"],
  }),
);
