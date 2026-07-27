import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { BatchDeleteMemoryRecords } from "./BatchDeleteMemoryRecords.ts";
import type { Memory } from "./Memory.ts";

export const BatchDeleteMemoryRecordsHttp = Layer.effect(
  BatchDeleteMemoryRecords,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.BatchDeleteMemoryRecords",
    operation: agentcore.batchDeleteMemoryRecords,
    actions: ["bedrock-agentcore:BatchDeleteMemoryRecords"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
