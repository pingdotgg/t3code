import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { CreateEvent } from "./CreateEvent.ts";
import type { Memory } from "./Memory.ts";

export const CreateEventHttp = Layer.effect(
  CreateEvent,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.CreateEvent",
    operation: agentcore.createEvent,
    actions: ["bedrock-agentcore:CreateEvent"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
