import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { BatchCreateMemoryRecords } from "./BatchCreateMemoryRecords.ts";
import type { Memory } from "./Memory.ts";

export const BatchCreateMemoryRecordsHttp = Layer.effect(
  BatchCreateMemoryRecords,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.BatchCreateMemoryRecords",
    operation: agentcore.batchCreateMemoryRecords,
    actions: ["bedrock-agentcore:BatchCreateMemoryRecords"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
