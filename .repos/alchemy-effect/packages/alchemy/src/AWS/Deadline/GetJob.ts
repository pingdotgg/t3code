import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:GetJob`.
 *
 * Reads a job's detail in the bound {@link Queue} — lifecycle status, task
 * run status counts, priority, timing. The queue's `farmId`/`queueId` are
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Deadline.GetJobHttp)`.
 * @binding
 * @section Monitoring Jobs
 * @example Check A Job's Status
 * ```typescript
 * // init — bind the operation to the queue
 * const getJob = yield* AWS.Deadline.GetJob(queue);
 *
 * // runtime
 * const job = yield* getJob({ jobId });
 * if (job.taskRunStatus === "FAILED") {
 *   yield* Effect.logError(job.lifecycleStatusMessage);
 * }
 * ```
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "AWS.Deadline.GetJob",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.GetJobRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.GetJobResponse, deadline.GetJobError>
  >
> {}
export const GetJob = Binding.Service<GetJob>("AWS.Deadline.GetJob");
