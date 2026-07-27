import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:GetJob`.
 *
 * Reads a job's state (`WAITING`, `IN_PROGRESS`, `COMPLETED`, `ERROR`,
 * …) and typed error details — the polling half of every import/export
 * flow.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.GetJobHttp)`.
 * @binding
 * @section Import & Export Jobs
 * @example Poll A Job Until It Completes
 * ```typescript
 * const getJob = yield* AWS.DataExchange.GetJob();
 *
 * // runtime
 * const done = yield* getJob({ JobId: job.Id! }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (j) => j.State === "COMPLETED" || j.State === "ERROR",
 *     times: 30,
 *   }),
 * );
 * ```
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "AWS.DataExchange.GetJob",
  () => Effect.Effect<
    (
      request: dataexchange.GetJobRequest,
    ) => Effect.Effect<dataexchange.GetJobResponse, dataexchange.GetJobError>
  >
> {}
export const GetJob = Binding.Service<GetJob>("AWS.DataExchange.GetJob");
