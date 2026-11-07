import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { ListEvents } from "./ListEvents.ts";
import type { Memory } from "./Memory.ts";

export const ListEventsHttp = Layer.effect(
  ListEvents,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListEvents",
    operation: agentcore.listEvents,
    actions: ["bedrock-agentcore:ListEvents"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
