import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `GetKnowledgeBaseDocuments` request with the binding-injected
 * `knowledgeBaseId` and `dataSourceId` removed — they are supplied
 * automatically from the bound {@link DataSource}.
 */
export interface GetKnowledgeBaseDocumentsRequest extends Omit<
  bedrock.GetKnowledgeBaseDocumentsRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:GetKnowledgeBaseDocuments` — read the
 * ingestion status of specific documents in the bound {@link DataSource}.
 *
 * The binding grants the function `bedrock:GetKnowledgeBaseDocuments`
 * scoped to the data source's parent knowledge base.
 *
 * @binding
 * @section Direct Document Ingestion
 * @example Check a Document's Ingestion Status
 * ```typescript
 * // init
 * const getDocuments = yield* Bedrock.GetKnowledgeBaseDocuments(dataSource);
 *
 * // runtime
 * const { documentDetails } = yield* getDocuments({
 *   documentIdentifiers: [
 *     { dataSourceType: "CUSTOM", custom: { id: "welcome-doc" } },
 *   ],
 * });
 * const status = documentDetails?.[0]?.status; // e.g. "INDEXED"
 * ```
 */
export interface GetKnowledgeBaseDocuments extends Binding.Service<
  GetKnowledgeBaseDocuments,
  "AWS.Bedrock.GetKnowledgeBaseDocuments",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: GetKnowledgeBaseDocumentsRequest,
    ) => Effect.Effect<
      bedrock.GetKnowledgeBaseDocumentsResponse,
      bedrock.GetKnowledgeBaseDocumentsError
    >
  >
> {}
export const GetKnowledgeBaseDocuments =
  Binding.Service<GetKnowledgeBaseDocuments>(
    "AWS.Bedrock.GetKnowledgeBaseDocuments",
  );
