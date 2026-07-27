import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface GetReferenceMetadataRequest extends Omit<
  omics.GetReferenceMetadataRequest,
  "referenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReferenceMetadata`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that reads the metadata of a reference genome — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReferenceMetadataHttp)`.
 * @binding
 * @section References
 * @example Bind GetReferenceMetadata to a ReferenceStore
 * ```typescript
 * // init
 * const getReferenceMetadata = yield* AWS.Omics.GetReferenceMetadata(store);
 * // runtime
 * const result = yield* getReferenceMetadata({});
 * ```
 */
export interface GetReferenceMetadata extends Binding.Service<
  GetReferenceMetadata,
  "AWS.Omics.GetReferenceMetadata",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: GetReferenceMetadataRequest,
    ) => Effect.Effect<
      omics.GetReferenceMetadataResponse,
      omics.GetReferenceMetadataError
    >
  >
> {}

export const GetReferenceMetadata = Binding.Service<GetReferenceMetadata>(
  "AWS.Omics.GetReferenceMetadata",
);
