import type * as qbusiness from "@distilled.cloud/aws/qbusiness";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `BatchPutDocument` request with `applicationId` + `indexId` injected from the bound index.
 */
export interface BatchPutDocumentRequest extends Omit<
  qbusiness.BatchPutDocumentRequest,
  "applicationId" | "indexId"
> {}

/**
 * Runtime binding for the `BatchPutDocument` operation (IAM action
 * `qbusiness:BatchPutDocument`), scoped to one {@link Index}.
 *
 * Adds or updates documents in the index directly (the CUSTOM data
 * source path), with optional access controls and enrichment.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.BatchPutDocumentHttp)`.
 *
 * @binding
 * @section Document Ingestion
 * @example Push Documents into an Index
 * ```typescript
 * const putDocuments = yield* AWS.QBusiness.BatchPutDocument(index);
 *
 * const { failedDocuments } = yield* putDocuments({
 *   documents: [
 *     {
 *       id: "welcome",
 *       title: "Welcome",
 *       content: { blob: new TextEncoder().encode("Hello Q!") },
 *       contentType: "PLAIN_TEXT",
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchPutDocument extends Binding.Service<
  BatchPutDocument,
  "AWS.QBusiness.BatchPutDocument",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: BatchPutDocumentRequest,
    ) => Effect.Effect<
      qbusiness.BatchPutDocumentResponse,
      qbusiness.BatchPutDocumentError
    >
  >
> {}
export const BatchPutDocument = Binding.Service<BatchPutDocument>(
  "AWS.QBusiness.BatchPutDocument",
);
