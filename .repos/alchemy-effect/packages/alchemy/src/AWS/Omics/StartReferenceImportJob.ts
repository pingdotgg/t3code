import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface StartReferenceImportJobRequest extends Omit<
  omics.StartReferenceImportJobRequest,
  "referenceStoreId"
> {}

/**
 * Runtime binding for `omics:StartReferenceImportJob`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that starts a job that imports reference genomes into the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.StartReferenceImportJobHttp)`.
 * @binding
 * @section References
 * @example Bind StartReferenceImportJob to a ReferenceStore
 * ```typescript
 * // init
 * const startReferenceImportJob = yield* AWS.Omics.StartReferenceImportJob(store);
 * // runtime
 * const result = yield* startReferenceImportJob({});
 * ```
 */
export interface StartReferenceImportJob extends Binding.Service<
  StartReferenceImportJob,
  "AWS.Omics.StartReferenceImportJob",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: StartReferenceImportJobRequest,
    ) => Effect.Effect<
      omics.StartReferenceImportJobResponse,
      omics.StartReferenceImportJobError
    >
  >
> {}

export const StartReferenceImportJob = Binding.Service<StartReferenceImportJob>(
  "AWS.Omics.StartReferenceImportJob",
);
