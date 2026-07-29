import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface GetReferenceImportJobRequest extends Omit<
  omics.GetReferenceImportJobRequest,
  "referenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReferenceImportJob`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that reads the status of a reference import job — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReferenceImportJobHttp)`.
 * @binding
 * @section References
 * @example Bind GetReferenceImportJob to a ReferenceStore
 * ```typescript
 * // init
 * const getReferenceImportJob = yield* AWS.Omics.GetReferenceImportJob(store);
 * // runtime
 * const result = yield* getReferenceImportJob({});
 * ```
 */
export interface GetReferenceImportJob extends Binding.Service<
  GetReferenceImportJob,
  "AWS.Omics.GetReferenceImportJob",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: GetReferenceImportJobRequest,
    ) => Effect.Effect<
      omics.GetReferenceImportJobResponse,
      omics.GetReferenceImportJobError
    >
  >
> {}

export const GetReferenceImportJob = Binding.Service<GetReferenceImportJob>(
  "AWS.Omics.GetReferenceImportJob",
);
