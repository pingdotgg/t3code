import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { GetMemoryRecord } from "./GetMemoryRecord.ts";
import type { Memory } from "./Memory.ts";

export const GetMemoryRecordHttp = Layer.effect(
  GetMemoryRecord,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.GetMemoryRecord",
    operation: agentcore.getMemoryRecord,
    actions: ["bedrock-agentcore:GetMemoryRecord"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
