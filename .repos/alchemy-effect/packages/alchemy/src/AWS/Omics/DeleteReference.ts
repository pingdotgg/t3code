import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface DeleteReferenceRequest extends Omit<
  omics.DeleteReferenceRequest,
  "referenceStoreId"
> {}

/**
 * Runtime binding for `omics:DeleteReference`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that deletes a reference genome from the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.DeleteReferenceHttp)`.
 * @binding
 * @section References
 * @example Bind DeleteReference to a ReferenceStore
 * ```typescript
 * // init
 * const deleteReference = yield* AWS.Omics.DeleteReference(store);
 * // runtime
 * const result = yield* deleteReference({});
 * ```
 */
export interface DeleteReference extends Binding.Service<
  DeleteReference,
  "AWS.Omics.DeleteReference",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: DeleteReferenceRequest,
    ) => Effect.Effect<
      omics.DeleteReferenceResponse,
      omics.DeleteReferenceError
    >
  >
> {}

export const DeleteReference = Binding.Service<DeleteReference>(
  "AWS.Omics.DeleteReference",
);
