import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `ListKnowledgeBaseDocuments` request with the binding-injected
 * `knowledgeBaseId` and `dataSourceId` removed — they are supplied
 * automatically from the bound {@link DataSource}.
 */
export interface ListKnowledgeBaseDocumentsRequest extends Omit<
  bedrock.ListKnowledgeBaseDocumentsRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:ListKnowledgeBaseDocuments` — list the
 * documents tracked in the bound {@link DataSource} together with their
 * ingestion status.
 *
 * The binding grants the function `bedrock:ListKnowledgeBaseDocuments`
 * scoped to the data source's parent knowledge base.
 *
 * @binding
 * @section Direct Document Ingestion
 * @example List Tracked Documents
 * ```typescript
 * // init
 * const listDocuments = yield* Bedrock.ListKnowledgeBaseDocuments(dataSource);
 *
 * // runtime
 * const { documentDetails } = yield* listDocuments({ maxResults: 25 });
 * ```
 */
export interface ListKnowledgeBaseDocuments extends Binding.Service<
  ListKnowledgeBaseDocuments,
  "AWS.Bedrock.ListKnowledgeBaseDocuments",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: ListKnowledgeBaseDocumentsRequest,
    ) => Effect.Effect<
      bedrock.ListKnowledgeBaseDocumentsResponse,
      bedrock.ListKnowledgeBaseDocumentsError
    >
  >
> {}
export const ListKnowledgeBaseDocuments =
  Binding.Service<ListKnowledgeBaseDocuments>(
    "AWS.Bedrock.ListKnowledgeBaseDocuments",
  );
