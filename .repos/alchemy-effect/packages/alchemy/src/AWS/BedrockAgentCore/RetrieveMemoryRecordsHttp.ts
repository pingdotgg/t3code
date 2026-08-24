import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { RetrieveMemoryRecords } from "./RetrieveMemoryRecords.ts";
import type { Memory } from "./Memory.ts";

export const RetrieveMemoryRecordsHttp = Layer.effect(
  RetrieveMemoryRecords,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.RetrieveMemoryRecords",
    operation: agentcore.retrieveMemoryRecords,
    actions: ["bedrock-agentcore:RetrieveMemoryRecords"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
