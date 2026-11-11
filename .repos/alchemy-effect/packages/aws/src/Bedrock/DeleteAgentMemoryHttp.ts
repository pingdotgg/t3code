import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Layer from "effect/Layer";
import { makeAgentAliasScopedHttpBinding } from "./BindingHttp.ts";
import { DeleteAgentMemory } from "./DeleteAgentMemory.ts";

export const DeleteAgentMemoryHttp = Layer.effect(
  DeleteAgentMemory,
  makeAgentAliasScopedHttpBinding({
    tag: "AWS.Bedrock.DeleteAgentMemory",
    operation: bedrock.deleteAgentMemory,
    actions: ["bedrock:DeleteAgentMemory"],
  }),
);
