import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import type { Runtime } from "./Runtime.ts";
import { StopRuntimeSession } from "./StopRuntimeSession.ts";

export const StopRuntimeSessionHttp = Layer.effect(
  StopRuntimeSession,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.StopRuntimeSession",
    operation: agentcore.stopRuntimeSession,
    actions: ["bedrock-agentcore:StopRuntimeSession"],
    requestKey: "agentRuntimeArn",
    identifier: (runtime: Runtime) => runtime.agentRuntimeArn,
    arns: (runtime: Runtime) => [
      runtime.agentRuntimeArn,
      // qualified invocations target a runtime endpoint sub-resource.
      Output.interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`,
    ],
  }),
);
