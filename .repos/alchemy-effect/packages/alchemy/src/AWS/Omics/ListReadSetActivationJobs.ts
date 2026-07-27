import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface ListReadSetActivationJobsRequest extends Omit<
  omics.ListReadSetActivationJobsRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:ListReadSetActivationJobs`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that lists the read-set activation jobs for the store — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.ListReadSetActivationJobsHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind ListReadSetActivationJobs to a SequenceStore
 * ```typescript
 * // init
 * const listReadSetActivationJobs = yield* AWS.Omics.ListReadSetActivationJobs(store);
 * // runtime
 * const result = yield* listReadSetActivationJobs({});
 * ```
 */
export interface ListReadSetActivationJobs extends Binding.Service<
  ListReadSetActivationJobs,
  "AWS.Omics.ListReadSetActivationJobs",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: ListReadSetActivationJobsRequest,
    ) => Effect.Effect<
      omics.ListReadSetActivationJobsResponse,
      omics.ListReadSetActivationJobsError
    >
  >
> {}

export const ListReadSetActivationJobs =
  Binding.Service<ListReadSetActivationJobs>(
    "AWS.Omics.ListReadSetActivationJobs",
  );
