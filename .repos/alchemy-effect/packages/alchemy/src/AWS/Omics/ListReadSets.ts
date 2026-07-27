import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface ListReadSetsRequest extends Omit<
  omics.ListReadSetsRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:ListReadSets`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that lists the read sets in the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.ListReadSetsHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind ListReadSets to a SequenceStore
 * ```typescript
 * // init
 * const listReadSets = yield* AWS.Omics.ListReadSets(store);
 * // runtime
 * const result = yield* listReadSets({});
 * ```
 */
export interface ListReadSets extends Binding.Service<
  ListReadSets,
  "AWS.Omics.ListReadSets",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: ListReadSetsRequest,
    ) => Effect.Effect<omics.ListReadSetsResponse, omics.ListReadSetsError>
  >
> {}

export const ListReadSets = Binding.Service<ListReadSets>(
  "AWS.Omics.ListReadSets",
);
