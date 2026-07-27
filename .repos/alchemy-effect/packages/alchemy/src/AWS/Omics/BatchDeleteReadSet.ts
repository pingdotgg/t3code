import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface BatchDeleteReadSetRequest extends Omit<
  omics.BatchDeleteReadSetRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:BatchDeleteReadSet`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that deletes a batch of read sets from the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.BatchDeleteReadSetHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind BatchDeleteReadSet to a SequenceStore
 * ```typescript
 * // init
 * const batchDeleteReadSet = yield* AWS.Omics.BatchDeleteReadSet(store);
 * // runtime
 * const result = yield* batchDeleteReadSet({});
 * ```
 */
export interface BatchDeleteReadSet extends Binding.Service<
  BatchDeleteReadSet,
  "AWS.Omics.BatchDeleteReadSet",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: BatchDeleteReadSetRequest,
    ) => Effect.Effect<
      omics.BatchDeleteReadSetResponse,
      omics.BatchDeleteReadSetError
    >
  >
> {}

export const BatchDeleteReadSet = Binding.Service<BatchDeleteReadSet>(
  "AWS.Omics.BatchDeleteReadSet",
);
