import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { InvokeAgentRuntime } from "./InvokeAgentRuntime.ts";
import type { Runtime } from "./Runtime.ts";

export const InvokeAgentRuntimeHttp = Layer.effect(
  InvokeAgentRuntime,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.InvokeAgentRuntime",
    operation: agentcore.invokeAgentRuntime,
    actions: ["bedrock-agentcore:InvokeAgentRuntime"],
    requestKey: "agentRuntimeArn",
    identifier: (runtime: Runtime) => runtime.agentRuntimeArn,
    arns: (runtime: Runtime) => [
      runtime.agentRuntimeArn,
      // qualified invocations target a runtime endpoint sub-resource.
      Output.interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`,
    ],
  }),
);
