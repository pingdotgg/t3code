import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `BatchPutDocument` request with `IndexId` injected from the bound index.
 */
export interface BatchPutDocumentRequest extends Omit<
  kendra.BatchPutDocumentRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `BatchPutDocument` operation (IAM action
 * `kendra:BatchPutDocument`), scoped to one {@link Index}.
 *
 * Adds documents directly to the index (inline blobs or S3 paths) —
 * the push-API alternative to a data-source sync. Check the response's
 * `FailedDocuments` for per-document errors; documents index
 * asynchronously (poll with {@link BatchGetDocumentStatus}).
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.BatchPutDocumentHttp)`.
 *
 * @binding
 * @section Indexing Documents
 * @example Index Documents Inline
 * ```typescript
 * const putDocuments = yield* AWS.Kendra.BatchPutDocument(index);
 *
 * const result = yield* putDocuments({
 *   Documents: [
 *     {
 *       Id: "welcome",
 *       Title: "Welcome",
 *       Blob: new TextEncoder().encode("Hello from Alchemy"),
 *       ContentType: "PLAIN_TEXT",
 *     },
 *   ],
 * });
 * // result.FailedDocuments is empty on success
 * ```
 */
export interface BatchPutDocument extends Binding.Service<
  BatchPutDocument,
  "AWS.Kendra.BatchPutDocument",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: BatchPutDocumentRequest,
    ) => Effect.Effect<
      kendra.BatchPutDocumentResponse,
      kendra.BatchPutDocumentError
    >
  >
> {}
export const BatchPutDocument = Binding.Service<BatchPutDocument>(
  "AWS.Kendra.BatchPutDocument",
);
