import type * as kendra from "@distilled.cloud/aws/kendra";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `BatchGetDocumentStatus` request with `IndexId` injected from the bound index.
 */
export interface BatchGetDocumentStatusRequest extends Omit<
  kendra.BatchGetDocumentStatusRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `BatchGetDocumentStatus` operation (IAM action
 * `kendra:BatchGetDocumentStatus`), scoped to one {@link Index}.
 *
 * Returns the indexing status (`INDEXED`, `PROCESSING`, `FAILED`, …) of
 * documents added with {@link BatchPutDocument} or a data-source sync.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.BatchGetDocumentStatusHttp)`.
 *
 * @binding
 * @section Indexing Documents
 * @example Check Document Status
 * ```typescript
 * const documentStatus = yield* AWS.Kendra.BatchGetDocumentStatus(index);
 *
 * const status = yield* documentStatus({
 *   DocumentInfoList: [{ DocumentId: "welcome" }],
 * });
 * console.log(status.DocumentStatusList?.[0]?.DocumentStatus);
 * ```
 */
export interface BatchGetDocumentStatus extends Binding.Service<
  BatchGetDocumentStatus,
  "AWS.Kendra.BatchGetDocumentStatus",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: BatchGetDocumentStatusRequest,
    ) => Effect.Effect<
      kendra.BatchGetDocumentStatusResponse,
      kendra.BatchGetDocumentStatusError
    >
  >
> {}
export const BatchGetDocumentStatus = Binding.Service<BatchGetDocumentStatus>(
  "AWS.Kendra.BatchGetDocumentStatus",
);
