import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface GetReadSetMetadataRequest extends Omit<
  omics.GetReadSetMetadataRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReadSetMetadata`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that reads the metadata of a read set — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReadSetMetadataHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind GetReadSetMetadata to a SequenceStore
 * ```typescript
 * // init
 * const getReadSetMetadata = yield* AWS.Omics.GetReadSetMetadata(store);
 * // runtime
 * const result = yield* getReadSetMetadata({});
 * ```
 */
export interface GetReadSetMetadata extends Binding.Service<
  GetReadSetMetadata,
  "AWS.Omics.GetReadSetMetadata",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: GetReadSetMetadataRequest,
    ) => Effect.Effect<
      omics.GetReadSetMetadataResponse,
      omics.GetReadSetMetadataError
    >
  >
> {}

export const GetReadSetMetadata = Binding.Service<GetReadSetMetadata>(
  "AWS.Omics.GetReadSetMetadata",
);
