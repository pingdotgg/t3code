import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `DeleteKnowledgeBaseDocuments` request with the binding-injected
 * `knowledgeBaseId` and `dataSourceId` removed — they are supplied
 * automatically from the bound {@link DataSource}.
 */
export interface DeleteKnowledgeBaseDocumentsRequest extends Omit<
  bedrock.DeleteKnowledgeBaseDocumentsRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:DeleteKnowledgeBaseDocuments` — remove
 * specific documents from the bound {@link DataSource}'s knowledge base
 * index.
 *
 * The binding grants the function `bedrock:DeleteKnowledgeBaseDocuments`
 * scoped to the data source's parent knowledge base.
 *
 * @binding
 * @section Direct Document Ingestion
 * @example Delete a Document
 * ```typescript
 * // init
 * const deleteDocuments =
 *   yield* Bedrock.DeleteKnowledgeBaseDocuments(dataSource);
 *
 * // runtime
 * yield* deleteDocuments({
 *   documentIdentifiers: [
 *     { dataSourceType: "CUSTOM", custom: { id: "welcome-doc" } },
 *   ],
 * });
 * ```
 */
export interface DeleteKnowledgeBaseDocuments extends Binding.Service<
  DeleteKnowledgeBaseDocuments,
  "AWS.Bedrock.DeleteKnowledgeBaseDocuments",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: DeleteKnowledgeBaseDocumentsRequest,
    ) => Effect.Effect<
      bedrock.DeleteKnowledgeBaseDocumentsResponse,
      bedrock.DeleteKnowledgeBaseDocumentsError
    >
  >
> {}
export const DeleteKnowledgeBaseDocuments =
  Binding.Service<DeleteKnowledgeBaseDocuments>(
    "AWS.Bedrock.DeleteKnowledgeBaseDocuments",
  );
