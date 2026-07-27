import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SequenceStore } from "./SequenceStore.ts";

export interface StartReadSetActivationJobRequest extends Omit<
  omics.StartReadSetActivationJobRequest,
  "sequenceStoreId"
> {}

/**
 * Runtime binding for `omics:StartReadSetActivationJob`.
 *
 * Bind this operation to a `SequenceStore` to get a callable that starts a job that activates archived read sets — the
 * store/workflow id is injected automatically and the action is granted on the
 * bound resource. Provide the implementation with
 * `Effect.provide(AWS.Omics.StartReadSetActivationJobHttp)`.
 * @binding
 * @section Read Sets
 * @example Bind StartReadSetActivationJob to a SequenceStore
 * ```typescript
 * // init
 * const startReadSetActivationJob = yield* AWS.Omics.StartReadSetActivationJob(store);
 * // runtime
 * const result = yield* startReadSetActivationJob({});
 * ```
 */
export interface StartReadSetActivationJob extends Binding.Service<
  StartReadSetActivationJob,
  "AWS.Omics.StartReadSetActivationJob",
  (
    store: SequenceStore,
  ) => Effect.Effect<
    (
      request?: StartReadSetActivationJobRequest,
    ) => Effect.Effect<
      omics.StartReadSetActivationJobResponse,
      omics.StartReadSetActivationJobError
    >
  >
> {}

export const StartReadSetActivationJob =
  Binding.Service<StartReadSetActivationJob>(
    "AWS.Omics.StartReadSetActivationJob",
  );
