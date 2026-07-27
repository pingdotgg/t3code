import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `BatchDeleteDocument` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface BatchDeleteDocumentRequest extends Omit<
  qbusiness.BatchDeleteDocumentRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `BatchDeleteDocument` operation (IAM action
 * `qbusiness:BatchDeleteDocument`), scoped to one {@link Index}.
 *
 * Removes documents from the index by document id.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.BatchDeleteDocumentHttp)`.
 *
 * @binding
 * @section Document Ingestion
 * @example Delete Documents from an Index
 * ```typescript
 * const deleteDocuments = yield* AWS.QBusiness.BatchDeleteDocument(index);
 *
 * yield* deleteDocuments({ documents: [{ documentId: "welcome" }] });
 * ```
 */
export interface BatchDeleteDocument extends Binding.Service<
  BatchDeleteDocument,
  "AWS.QBusiness.BatchDeleteDocument",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: BatchDeleteDocumentRequest,
    ) => Effect.Effect<
      qbusiness.BatchDeleteDocumentResponse,
      qbusiness.BatchDeleteDocumentError
    >
  >
> {}
export const BatchDeleteDocument = Binding.Service<BatchDeleteDocument>(
  "AWS.QBusiness.BatchDeleteDocument",
);
