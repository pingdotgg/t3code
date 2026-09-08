import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:CancelJob`.
 *
 * Cancels a job that has not yet been started (`WAITING` state).
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.CancelJobHttp)`.
 * ### Import & Export Jobs
 * **Example:** Cancel A Waiting Job
 * ```typescript
 * const cancelJob = yield* AWS.DataExchange.CancelJob();
 *
 * // runtime
 * yield* cancelJob({ JobId: job.Id! });
 * ```
 *
 * @binding
 */
export interface CancelJob extends Binding.Service<
  CancelJob,
  "AWS.DataExchange.CancelJob",
  () => Effect.Effect<
    (
      request: dataexchange.CancelJobRequest,
    ) => Effect.Effect<
      dataexchange.CancelJobResponse,
      dataexchange.CancelJobError
    >
  >
> {}
export const CancelJob = Binding.Service<CancelJob>(
  "AWS.DataExchange.CancelJob",
);
