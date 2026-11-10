import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { InvokeAgentRuntimeCommand } from "./InvokeAgentRuntimeCommand.ts";
import type { Runtime } from "./Runtime.ts";

export const InvokeAgentRuntimeCommandHttp = Layer.effect(
  InvokeAgentRuntimeCommand,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.InvokeAgentRuntimeCommand",
    operation: agentcore.invokeAgentRuntimeCommand,
    actions: ["bedrock-agentcore:InvokeAgentRuntimeCommand"],
    requestKey: "agentRuntimeArn",
    identifier: (runtime: Runtime) => runtime.agentRuntimeArn,
    arns: (runtime: Runtime) => [
      runtime.agentRuntimeArn,
      // qualified invocations target a runtime endpoint sub-resource.
      Output.interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`,
    ],
  }),
);
