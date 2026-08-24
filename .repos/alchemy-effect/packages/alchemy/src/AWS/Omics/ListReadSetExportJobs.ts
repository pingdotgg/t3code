import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface ListReadSetExportJobsRequest extends Omit<
  omics.ListReadSetExportJobsRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:ListReadSetExportJobs`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that lists the read-set export jobs for the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.ListReadSetExportJobsHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind ListReadSetExportJobs to a SequenceStore
 * ```typescript
 * // init
 * const listReadSetExportJobs = yield* AWS.Omics.ListReadSetExportJobs(store);
 * // runtime
 * const result = yield* listReadSetExportJobs({});
 * ```
 */
export interface ListReadSetExportJobs extends Binding.Service<
  ListReadSetExportJobs,
  "AWS.Omics.ListReadSetExportJobs",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: ListReadSetExportJobsRequest,
    ) => Effect.Effect<
      omics.ListReadSetExportJobsResponse,
      omics.ListReadSetExportJobsError
    >
  >
> {}

export const ListReadSetExportJobs = Binding.Service<ListReadSetExportJobs>(
  "AWS.Omics.ListReadSetExportJobs",
);
