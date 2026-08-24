import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { GetAgentCard } from "./GetAgentCard.ts";
import type { Runtime } from "./Runtime.ts";

export const GetAgentCardHttp = Layer.effect(
  GetAgentCard,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.GetAgentCard",
    operation: agentcore.getAgentCard,
    actions: ["bedrock-agentcore:GetAgentCard"],
    requestKey: "agentRuntimeArn",
    identifier: (runtime: Runtime) => runtime.agentRuntimeArn,
    arns: (runtime: Runtime) => [
      runtime.agentRuntimeArn,
      // qualified invocations target a runtime endpoint sub-resource.
      Output.interpolate`${runtime.agentRuntimeArn}/runtime-endpoint/*`,
    ],
  }),
);
