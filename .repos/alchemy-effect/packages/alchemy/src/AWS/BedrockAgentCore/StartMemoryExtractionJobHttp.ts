import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { StartMemoryExtractionJob } from "./StartMemoryExtractionJob.ts";
import type { Memory } from "./Memory.ts";

export const StartMemoryExtractionJobHttp = Layer.effect(
  StartMemoryExtractionJob,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.StartMemoryExtractionJob",
    operation: agentcore.startMemoryExtractionJob,
    actions: ["bedrock-agentcore:StartMemoryExtractionJob"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
