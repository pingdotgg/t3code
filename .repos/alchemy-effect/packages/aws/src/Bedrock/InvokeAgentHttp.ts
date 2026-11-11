import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Layer from "effect/Layer";
import { makeAgentAliasScopedHttpBinding } from "./BindingHttp.ts";
import { InvokeAgent } from "./InvokeAgent.ts";

export const InvokeAgentHttp = Layer.effect(
  InvokeAgent,
  makeAgentAliasScopedHttpBinding({
    tag: "AWS.Bedrock.InvokeAgent",
    operation: bedrock.invokeAgent,
    actions: ["bedrock:InvokeAgent"],
  }),
);
