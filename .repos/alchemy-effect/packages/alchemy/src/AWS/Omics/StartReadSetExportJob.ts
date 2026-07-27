import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface StartReadSetExportJobRequest extends Omit<
  omics.StartReadSetExportJobRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:StartReadSetExportJob`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that starts a job that exports read sets to S3 — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.StartReadSetExportJobHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind StartReadSetExportJob to a SequenceStore
 * ```typescript
 * // init
 * const startReadSetExportJob = yield* AWS.Omics.StartReadSetExportJob(store);
 * // runtime
 * const result = yield* startReadSetExportJob({});
 * ```
 */
export interface StartReadSetExportJob extends Binding.Service<
  StartReadSetExportJob,
  "AWS.Omics.StartReadSetExportJob",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: StartReadSetExportJobRequest,
    ) => Effect.Effect<
      omics.StartReadSetExportJobResponse,
      omics.StartReadSetExportJobError
    >
  >
> {}

export const StartReadSetExportJob = Binding.Service<StartReadSetExportJob>(
  "AWS.Omics.StartReadSetExportJob",
);
