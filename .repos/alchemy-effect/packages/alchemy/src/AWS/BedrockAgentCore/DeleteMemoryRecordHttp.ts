import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { DeleteMemoryRecord } from "./DeleteMemoryRecord.ts";
import type { Memory } from "./Memory.ts";

export const DeleteMemoryRecordHttp = Layer.effect(
  DeleteMemoryRecord,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.DeleteMemoryRecord",
    operation: agentcore.deleteMemoryRecord,
    actions: ["bedrock-agentcore:DeleteMemoryRecord"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
