import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";

export interface ListReferenceImportJobsRequest extends Omit<
  omics.ListReferenceImportJobsRequest,
  "referenceStoreId"
> {}

/**
 * Runtime binding for `omics:ListReferenceImportJobs`.
 *
 * Bind this operation to a `ReferenceStore` to get a callable that lists the reference import jobs for the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.ListReferenceImportJobsHttp)`.
 * @binding
 * @section References
 * @example Bind ListReferenceImportJobs to a ReferenceStore
 * ```typescript
 * // init
 * const listReferenceImportJobs = yield* AWS.Omics.ListReferenceImportJobs(store);
 * // runtime
 * const result = yield* listReferenceImportJobs({});
 * ```
 */
export interface ListReferenceImportJobs extends Binding.Service<
  ListReferenceImportJobs,
  "AWS.Omics.ListReferenceImportJobs",
  (
    store: ReferenceStore,
  ) => Effect.Effect<
    (
      request?: ListReferenceImportJobsRequest,
    ) => Effect.Effect<
      omics.ListReferenceImportJobsResponse,
      omics.ListReferenceImportJobsError
    >
  >
> {}

export const ListReferenceImportJobs = Binding.Service<ListReferenceImportJobs>(
  "AWS.Omics.ListReferenceImportJobs",
);
