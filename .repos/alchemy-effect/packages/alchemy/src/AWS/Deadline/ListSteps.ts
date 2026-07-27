import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:ListSteps`.
 *
 * Enumerates the steps of a job in the bound {@link Queue} (paginated).
 * The queue's `farmId`/`queueId` are injected from the binding. Provide
 * the implementation with `Effect.provide(AWS.Deadline.ListStepsHttp)`.
 * @binding
 * @section Monitoring Steps
 * @example List A Job's Steps
 * ```typescript
 * // init — bind the operation to the queue
 * const listSteps = yield* AWS.Deadline.ListSteps(queue);
 *
 * // runtime
 * const { steps } = yield* listSteps({ jobId });
 * ```
 */
export interface ListSteps extends Binding.Service<
  ListSteps,
  "AWS.Deadline.ListSteps",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.ListStepsRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.ListStepsResponse, deadline.ListStepsError>
  >
> {}
export const ListSteps = Binding.Service<ListSteps>("AWS.Deadline.ListSteps");
