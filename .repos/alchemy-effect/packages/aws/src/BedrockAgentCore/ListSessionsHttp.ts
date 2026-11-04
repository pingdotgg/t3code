import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Layer from "effect/Layer";
import { makeAgentCoreHttpBinding } from "./BindingHttp.ts";
import { ListSessions } from "./ListSessions.ts";
import type { Memory } from "./Memory.ts";

export const ListSessionsHttp = Layer.effect(
  ListSessions,
  makeAgentCoreHttpBinding({
    tag: "AWS.BedrockAgentCore.ListSessions",
    operation: agentcore.listSessions,
    actions: ["bedrock-agentcore:ListSessions"],
    requestKey: "memoryId",
    identifier: (memory: Memory) => memory.memoryId,
    arns: (memory: Memory) => [memory.memoryArn],
  }),
);
