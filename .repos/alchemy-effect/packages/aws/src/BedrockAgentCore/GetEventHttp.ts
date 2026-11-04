import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { GetEvent } from "./GetEvent.ts";
import type { Memory } from "./Memory.ts";

export const GetEventHttp = Layer.effect(
  GetEvent,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.GetEvent",
    operation: agentcore.getEvent,
    actions: ["bedrock-agentcore:GetEvent"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
