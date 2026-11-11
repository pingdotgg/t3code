import * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import * as Layer from "effect/Layer";
import { makeModelScopedHttpBinding } from "./BindingHttp.ts";
import { ConverseStream } from "./ConverseStream.ts";

export const ConverseStreamHttp = Layer.effect(
  ConverseStream,
  makeModelScopedHttpBinding({
    tag: "AWS.Bedrock.ConverseStream",
    operation: bedrock.converseStream,
    // Streaming operations authorize against this action, not
    // bedrock:InvokeModel.
    actions: ["bedrock:InvokeModelWithResponseStream"],
  }),
);
