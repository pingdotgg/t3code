import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Layer from "effect/Layer";
import { makeDataSourceScopedHttpBinding } from "./BindingHttp.ts";
import { DeleteKnowledgeBaseDocuments } from "./DeleteKnowledgeBaseDocuments.ts";

export const DeleteKnowledgeBaseDocumentsHttp = Layer.effect(
  DeleteKnowledgeBaseDocuments,
  makeDataSourceScopedHttpBinding({
    tag: "AWS.Bedrock.DeleteKnowledgeBaseDocuments",
    operation: bedrock.deleteKnowledgeBaseDocuments,
    actions: ["bedrock:DeleteKnowledgeBaseDocuments"],
  }),
);
