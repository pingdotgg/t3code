import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface ListReadSetImportJobsRequest extends Omit<
  omics.ListReadSetImportJobsRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:ListReadSetImportJobs`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that lists the read-set import jobs for the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.ListReadSetImportJobsHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind ListReadSetImportJobs to a SequenceStore
 * ```typescript
 * // init
 * const listReadSetImportJobs = yield* AWS.Omics.ListReadSetImportJobs(store);
 * // runtime
 * const result = yield* listReadSetImportJobs({});
 * ```
 */
export interface ListReadSetImportJobs extends Binding.Service<
  ListReadSetImportJobs,
  "AWS.Omics.ListReadSetImportJobs",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: ListReadSetImportJobsRequest,
    ) => Effect.Effect<
      omics.ListReadSetImportJobsResponse,
      omics.ListReadSetImportJobsError
    >
  >
> {}

export const ListReadSetImportJobs = Binding.Service<ListReadSetImportJobs>(
  "AWS.Omics.ListReadSetImportJobs",
);
