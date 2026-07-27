import * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import * as Layer from "effect/Layer";
import { makeDataSourceScopedHttpBinding } from "./BindingHttp.ts";
import { ListKnowledgeBaseDocuments } from "./ListKnowledgeBaseDocuments.ts";

export const ListKnowledgeBaseDocumentsHttp = Layer.effect(
  ListKnowledgeBaseDocuments,
  makeDataSourceScopedHttpBinding({
    tag: "AWS.Bedrock.ListKnowledgeBaseDocuments",
    operation: bedrock.listKnowledgeBaseDocuments,
    actions: ["bedrock:ListKnowledgeBaseDocuments"],
  }),
);
