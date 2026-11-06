import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { ListMemoryRecords } from "./ListMemoryRecords.ts";
import type { Memory } from "./Memory.ts";

export const ListMemoryRecordsHttp = Layer.effect(
  ListMemoryRecords,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListMemoryRecords",
    operation: agentcore.listMemoryRecords,
    actions: ["bedrock-agentcore:ListMemoryRecords"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
