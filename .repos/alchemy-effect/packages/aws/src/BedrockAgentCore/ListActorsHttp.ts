import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { ListActors } from "./ListActors.ts";
import type { Memory } from "./Memory.ts";

export const ListActorsHttp = Layer.effect(
  ListActors,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListActors",
    operation: agentcore.listActors,
    actions: ["bedrock-agentcore:ListActors"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
