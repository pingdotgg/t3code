import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface GetReadSetActivationJobRequest extends Omit<
  omics.GetReadSetActivationJobRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:GetReadSetActivationJob`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that reads the status of a read-set activation job — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.GetReadSetActivationJobHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind GetReadSetActivationJob to a SequenceStore
 * ```typescript
 * // init
 * const getReadSetActivationJob = yield* AWS.Omics.GetReadSetActivationJob(store);
 * // runtime
 * const result = yield* getReadSetActivationJob({});
 * ```
 */
export interface GetReadSetActivationJob extends Binding.Service<
  GetReadSetActivationJob,
  "AWS.Omics.GetReadSetActivationJob",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: GetReadSetActivationJobRequest,
    ) => Effect.Effect<
      omics.GetReadSetActivationJobResponse,
      omics.GetReadSetActivationJobError
    >
  >
> {}

export const GetReadSetActivationJob = Binding.Service<GetReadSetActivationJob>(
  "AWS.Omics.GetReadSetActivationJob",
);
