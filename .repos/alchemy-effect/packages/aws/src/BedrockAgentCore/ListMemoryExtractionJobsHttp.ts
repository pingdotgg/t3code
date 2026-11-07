import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { ListMemoryExtractionJobs } from "./ListMemoryExtractionJobs.ts";
import type { Memory } from "./Memory.ts";

export const ListMemoryExtractionJobsHttp = Layer.effect(
  ListMemoryExtractionJobs,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListMemoryExtractionJobs",
    operation: agentcore.listMemoryExtractionJobs,
    actions: ["bedrock-agentcore:ListMemoryExtractionJobs"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
