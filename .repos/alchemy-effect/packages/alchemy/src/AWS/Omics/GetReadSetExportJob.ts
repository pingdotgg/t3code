import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface GetReadSetExportJobRequest extends Omit<
  omics.GetReadSetExportJobRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReadSetExportJob`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that reads the status of a read-set export job — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReadSetExportJobHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind GetReadSetExportJob to a SequenceStore
 * ```typescript
 * // init
 * const getReadSetExportJob = yield* AWS.Omics.GetReadSetExportJob(store);
 * // runtime
 * const result = yield* getReadSetExportJob({});
 * ```
 */
export interface GetReadSetExportJob extends Binding.Service<
  GetReadSetExportJob,
  "AWS.Omics.GetReadSetExportJob",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: GetReadSetExportJobRequest,
    ) => Effect.Effect<
      omics.GetReadSetExportJobResponse,
      omics.GetReadSetExportJobError
    >
  >
> {}

export const GetReadSetExportJob = Binding.Service<GetReadSetExportJob>(
  "AWS.Omics.GetReadSetExportJob",
);
