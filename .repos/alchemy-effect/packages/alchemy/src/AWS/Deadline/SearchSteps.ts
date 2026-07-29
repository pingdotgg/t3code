import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:SearchSteps`.
 *
 * Searches the steps of the bound {@link Queue} (optionally narrowed to one
 * `jobId`) with filter and sort expressions. The queue's
 * `farmId`/`queueIds: [queueId]` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.SearchStepsHttp)`.
 * @binding
 * @section Monitoring Steps
 * @example Find A Job's Failed Steps
 * ```typescript
 * // init — bind the operation to the queue
 * const searchSteps = yield* AWS.Deadline.SearchSteps(queue);
 *
 * // runtime
 * const { steps } = yield* searchSteps({
 *   itemOffset: 0,
 *   jobId,
 *   filterExpressions: {
 *     operator: "AND",
 *     filters: [
 *       {
 *         stringFilter: {
 *           name: "TASK_RUN_STATUS",
 *           operator: "EQUAL",
 *           value: "FAILED",
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export interface SearchSteps extends Binding.Service<
  SearchSteps,
  "AWS.Deadline.SearchSteps",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.SearchStepsRequest, "farmId" | "queueIds">,
    ) => Effect.Effect<deadline.SearchStepsResponse, deadline.SearchStepsError>
  >
> {}
export const SearchSteps = Binding.Service<SearchSteps>(
  "AWS.Deadline.SearchSteps",
);
