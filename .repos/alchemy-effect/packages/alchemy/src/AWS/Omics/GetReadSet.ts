import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface GetReadSetRequest extends Omit<
  omics.GetReadSetRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReadSet`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that streams the bytes of a read set file part — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReadSetHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind GetReadSet to a SequenceStore
 * ```typescript
 * // init
 * const getReadSet = yield* AWS.Omics.GetReadSet(store);
 * // runtime
 * const result = yield* getReadSet({});
 * ```
 */
export interface GetReadSet extends Binding.Service<
  GetReadSet,
  "AWS.Omics.GetReadSet",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: GetReadSetRequest,
    ) => Effect.Effect<omics.GetReadSetResponse, omics.GetReadSetError>
  >
> {}

export const GetReadSet = Binding.Service<GetReadSet>("AWS.Omics.GetReadSet");
