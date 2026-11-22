import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { DeleteEvent } from "./DeleteEvent.ts";
import type { Memory } from "./Memory.ts";

export const DeleteEventHttp = Layer.effect(
  DeleteEvent,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.DeleteEvent",
    operation: agentcore.deleteEvent,
    actions: ["bedrock-agentcore:DeleteEvent"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
