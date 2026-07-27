import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:GetStep`.
 *
 * Reads a step's detail for a job in the bound {@link Queue} — lifecycle
 * status, task run status counts, dependency counts, parameter space. The
 * queue's `farmId`/`queueId` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.GetStepHttp)`.
 * @binding
 * @section Monitoring Steps
 * @example Inspect A Step
 * ```typescript
 * // init — bind the operation to the queue
 * const getStep = yield* AWS.Deadline.GetStep(queue);
 *
 * // runtime
 * const step = yield* getStep({ jobId, stepId });
 * ```
 */
export interface GetStep extends Binding.Service<
  GetStep,
  "AWS.Deadline.GetStep",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.GetStepRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.GetStepResponse, deadline.GetStepError>
  >
> {}
export const GetStep = Binding.Service<GetStep>("AWS.Deadline.GetStep");
