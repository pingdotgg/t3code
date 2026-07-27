import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `IngestKnowledgeBaseDocuments` request with the binding-injected
 * `knowledgeBaseId` and `dataSourceId` removed — they are supplied
 * automatically from the bound {@link DataSource}.
 */
export interface IngestKnowledgeBaseDocumentsRequest extends Omit<
  bedrock.IngestKnowledgeBaseDocumentsRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:IngestKnowledgeBaseDocuments` — ingest
 * documents directly into the bound {@link DataSource}'s knowledge base
 * (inline text or S3 references) without running a full ingestion job.
 * The data source must be of type `CUSTOM` for inline content.
 *
 * The binding grants the function `bedrock:IngestKnowledgeBaseDocuments`
 * scoped to the data source's parent knowledge base.
 *
 * @binding
 * @section Direct Document Ingestion
 * @example Ingest an Inline Text Document
 * ```typescript
 * // init
 * const ingestDocuments =
 *   yield* Bedrock.IngestKnowledgeBaseDocuments(dataSource);
 *
 * // runtime
 * const { documentDetails } = yield* ingestDocuments({
 *   documents: [
 *     {
 *       content: {
 *         dataSourceType: "CUSTOM",
 *         custom: {
 *           customDocumentIdentifier: { id: "welcome-doc" },
 *           sourceType: "IN_LINE",
 *           inlineContent: {
 *             type: "TEXT",
 *             textContent: { data: "Alchemy is an IaE framework." },
 *           },
 *         },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export interface IngestKnowledgeBaseDocuments extends Binding.Service<
  IngestKnowledgeBaseDocuments,
  "AWS.Bedrock.IngestKnowledgeBaseDocuments",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: IngestKnowledgeBaseDocumentsRequest,
    ) => Effect.Effect<
      bedrock.IngestKnowledgeBaseDocumentsResponse,
      bedrock.IngestKnowledgeBaseDocumentsError
    >
  >
> {}
export const IngestKnowledgeBaseDocuments =
  Binding.Service<IngestKnowledgeBaseDocuments>(
    "AWS.Bedrock.IngestKnowledgeBaseDocuments",
  );
