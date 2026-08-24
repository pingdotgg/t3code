import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface ListReferencesRequest extends Omit<
  omics.ListReferencesRequest,
  "referenceStoreId"
> {}

/**
 * Runtime binding for `omics:ListReferences`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that lists the reference genomes in the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.ListReferencesHttp)`.
 * @binding
 * @section References
 * @example Bind ListReferences to a ReferenceStore
 * ```typescript
 * // init
 * const listReferences = yield* AWS.Omics.ListReferences(store);
 * // runtime
 * const result = yield* listReferences({});
 * ```
 */
export interface ListReferences extends Binding.Service<
  ListReferences,
  "AWS.Omics.ListReferences",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: ListReferencesRequest,
    ) => Effect.Effect<omics.ListReferencesResponse, omics.ListReferencesError>
  >
> {}

export const ListReferences = Binding.Service<ListReferences>(
  "AWS.Omics.ListReferences",
);
