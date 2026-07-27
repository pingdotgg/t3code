import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:UpdateStep`.
 *
 * Retargets every task of a step in the bound {@link Queue} — requeue
 * (`READY`), cancel (`CANCELED`), suspend (`SUSPENDED`), or force-fail/
 * succeed the step's tasks in one call. The queue's `farmId`/`queueId` are
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Deadline.UpdateStepHttp)`.
 * @binding
 * @section Managing Steps
 * @example Requeue A Step's Tasks
 * ```typescript
 * // init — bind the operation to the queue
 * const updateStep = yield* AWS.Deadline.UpdateStep(queue);
 *
 * // runtime
 * yield* updateStep({ jobId, stepId, targetTaskRunStatus: "READY" });
 * ```
 */
export interface UpdateStep extends Binding.Service<
  UpdateStep,
  "AWS.Deadline.UpdateStep",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.UpdateStepRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.UpdateStepResponse, deadline.UpdateStepError>
  >
> {}
export const UpdateStep = Binding.Service<UpdateStep>(
  "AWS.Deadline.UpdateStep",
);
