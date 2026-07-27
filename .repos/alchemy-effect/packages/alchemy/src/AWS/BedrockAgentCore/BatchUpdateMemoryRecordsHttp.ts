import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { BatchUpdateMemoryRecords } from "./BatchUpdateMemoryRecords.ts";
import type { Memory } from "./Memory.ts";

export const BatchUpdateMemoryRecordsHttp = Layer.effect(
  BatchUpdateMemoryRecords,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.BatchUpdateMemoryRecords",
    operation: agentcore.batchUpdateMemoryRecords,
    actions: ["bedrock-agentcore:BatchUpdateMemoryRecords"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
