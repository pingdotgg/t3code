import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Layer from "effect/Layer";
import { makeAgentAliasScopedHttpBinding } from "./BindingHttp.ts";
import { GetAgentMemory } from "./GetAgentMemory.ts";

export const GetAgentMemoryHttp = Layer.effect(
  GetAgentMemory,
  makeAgentAliasScopedHttpBinding({
    tag: "AWS.Bedrock.GetAgentMemory",
    operation: bedrock.getAgentMemory,
    actions: ["bedrock:GetAgentMemory"],
  }),
);
