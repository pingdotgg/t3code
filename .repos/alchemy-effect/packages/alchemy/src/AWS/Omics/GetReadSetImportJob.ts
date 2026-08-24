import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface GetReadSetImportJobRequest extends Omit<
  omics.GetReadSetImportJobRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReadSetImportJob`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that reads the status of a read-set import job — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReadSetImportJobHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind GetReadSetImportJob to a SequenceStore
 * ```typescript
 * // init
 * const getReadSetImportJob = yield* AWS.Omics.GetReadSetImportJob(store);
 * // runtime
 * const result = yield* getReadSetImportJob({});
 * ```
 */
export interface GetReadSetImportJob extends Binding.Service<
  GetReadSetImportJob,
  "AWS.Omics.GetReadSetImportJob",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: GetReadSetImportJobRequest,
    ) => Effect.Effect<
      omics.GetReadSetImportJobResponse,
      omics.GetReadSetImportJobError
    >
  >
> {}

export const GetReadSetImportJob = Binding.Service<GetReadSetImportJob>(
  "AWS.Omics.GetReadSetImportJob",
);
