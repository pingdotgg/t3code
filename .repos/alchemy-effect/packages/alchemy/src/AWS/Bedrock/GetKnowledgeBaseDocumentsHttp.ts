import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Layer from "effect/Layer";
import { makeDataSourceScopedHttpBinding } from "./BindingHttp.ts";
import { GetKnowledgeBaseDocuments } from "./GetKnowledgeBaseDocuments.ts";

export const GetKnowledgeBaseDocumentsHttp = Layer.effect(
  GetKnowledgeBaseDocuments,
  makeDataSourceScopedHttpBinding({
    tag: "AWS.Bedrock.GetKnowledgeBaseDocuments",
    operation: bedrock.getKnowledgeBaseDocuments,
    actions: ["bedrock:GetKnowledgeBaseDocuments"],
  }),
);
