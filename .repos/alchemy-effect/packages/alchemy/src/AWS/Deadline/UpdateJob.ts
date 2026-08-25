import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:UpdateJob`.
 *
 * Mutates a job in the bound {@link Queue} — reprioritize, cap failures, or
 * cancel/suspend/requeue it by setting `targetTaskRunStatus`. The queue's
 * `farmId`/`queueId` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.UpdateJobHttp)`.
 * @binding
 * @section Managing Jobs
 * @example Cancel A Job
 * ```typescript
 * // init — bind the operation to the queue
 * const updateJob = yield* AWS.Deadline.UpdateJob(queue);
 *
 * // runtime
 * yield* updateJob({ jobId, targetTaskRunStatus: "CANCELED" });
 * ```
 */
export interface UpdateJob extends Binding.Service<
  UpdateJob,
  "AWS.Deadline.UpdateJob",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.UpdateJobRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.UpdateJobResponse, deadline.UpdateJobError>
  >
> {}
export const UpdateJob = Binding.Service<UpdateJob>("AWS.Deadline.UpdateJob");
