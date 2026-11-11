import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Layer from "effect/Layer";
import { makeKnowledgeBaseScopedHttpBinding } from "./BindingHttp.ts";
import { Retrieve } from "./Retrieve.ts";

export const RetrieveHttp = Layer.effect(
  Retrieve,
  makeKnowledgeBaseScopedHttpBinding({
    tag: "AWS.Bedrock.Retrieve",
    operation: bedrock.retrieve,
    actions: ["bedrock:Retrieve"],
  }),
);
