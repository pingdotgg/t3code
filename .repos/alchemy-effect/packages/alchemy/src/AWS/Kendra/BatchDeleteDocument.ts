import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `BatchDeleteDocument` request with `IndexId` injected from the bound index.
 */
export interface BatchDeleteDocumentRequest extends Omit<
  kendra.BatchDeleteDocumentRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `BatchDeleteDocument` operation (IAM action
 * `kendra:BatchDeleteDocument`), scoped to one {@link Index}.
 *
 * Removes documents from the index by id. Check the response's
 * `FailedDocuments` for per-document errors.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.BatchDeleteDocumentHttp)`.
 *
 * @binding
 * @section Indexing Documents
 * @example Delete Documents
 * ```typescript
 * const deleteDocuments = yield* AWS.Kendra.BatchDeleteDocument(index);
 *
 * yield* deleteDocuments({ DocumentIdList: ["welcome"] });
 * ```
 */
export interface BatchDeleteDocument extends Binding.Service<
  BatchDeleteDocument,
  "AWS.Kendra.BatchDeleteDocument",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: BatchDeleteDocumentRequest,
    ) => Effect.Effect<
      kendra.BatchDeleteDocumentResponse,
      kendra.BatchDeleteDocumentError
    >
  >
> {}
export const BatchDeleteDocument = Binding.Service<BatchDeleteDocument>(
  "AWS.Kendra.BatchDeleteDocument",
);
