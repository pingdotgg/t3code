import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface StartReadSetImportJobRequest extends Omit<
  omics.StartReadSetImportJobRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:StartReadSetImportJob`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that starts an import job that ingests read sets into the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.StartReadSetImportJobHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind StartReadSetImportJob to a SequenceStore
 * ```typescript
 * // init
 * const startReadSetImportJob = yield* AWS.Omics.StartReadSetImportJob(store);
 * // runtime
 * const result = yield* startReadSetImportJob({});
 * ```
 */
export interface StartReadSetImportJob extends Binding.Service<
  StartReadSetImportJob,
  "AWS.Omics.StartReadSetImportJob",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: StartReadSetImportJobRequest,
    ) => Effect.Effect<
      omics.StartReadSetImportJobResponse,
      omics.StartReadSetImportJobError
    >
  >
> {}

export const StartReadSetImportJob = Binding.Service<StartReadSetImportJob>(
  "AWS.Omics.StartReadSetImportJob",
);
