import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface GetReferenceRequest extends Omit<
  omics.GetReferenceRequest,
  "referenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReference`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that streams the bytes of a reference file part — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReferenceHttp)`.
 * @binding
 * @section References
 * @example Bind GetReference to a ReferenceStore
 * ```typescript
 * // init
 * const getReference = yield* AWS.Omics.GetReference(store);
 * // runtime
 * const result = yield* getReference({});
 * ```
 */
export interface GetReference extends Binding.Service<
  GetReference,
  "AWS.Omics.GetReference",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: GetReferenceRequest,
    ) => Effect.Effect<omics.GetReferenceResponse, omics.GetReferenceError>
  >
> {}

export const GetReference = Binding.Service<GetReference>(
  "AWS.Omics.GetReference",
);
