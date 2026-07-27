import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:CreateJob`.
 *
 * Submits a render job to the bound {@link Queue} — the data-plane entry
 * point of Deadline Cloud. The job template is an Open Job Description
 * (OJD) document (`JSON` or `YAML`). The queue's `farmId`/`queueId` are
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Deadline.CreateJobHttp)`.
 * @binding
 * @section Submitting Jobs
 * @example Submit A Job From A Template
 * ```typescript
 * // init — bind the operation to the queue
 * const createJob = yield* AWS.Deadline.CreateJob(queue);
 *
 * // runtime
 * const { jobId } = yield* createJob({
 *   template: JSON.stringify(jobTemplate),
 *   templateType: "JSON",
 *   priority: 50,
 * });
 * ```
 */
export interface CreateJob extends Binding.Service<
  CreateJob,
  "AWS.Deadline.CreateJob",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.CreateJobRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.CreateJobResponse, deadline.CreateJobError>
  >
> {}
export const CreateJob = Binding.Service<CreateJob>("AWS.Deadline.CreateJob");
