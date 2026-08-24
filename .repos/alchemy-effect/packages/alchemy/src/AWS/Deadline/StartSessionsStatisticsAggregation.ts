import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Farm } from "./Farm.ts";

/**
 * Runtime binding for `deadline:StartSessionsStatisticsAggregation`.
 *
 * Starts an asynchronous usage/cost statistics aggregation over the bound
 * {@link Farm}'s queues or fleets. Poll the returned `aggregationId` with
 * {@link GetSessionsStatisticsAggregation} for the results. The farm's
 * `farmId` is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Deadline.StartSessionsStatisticsAggregationHttp)`.
 * @binding
 * @section Usage Statistics
 * @example Aggregate The Last 24 Hours Of Queue Cost
 * ```typescript
 * // init — bind the operation to the farm
 * const startAggregation =
 *   yield* AWS.Deadline.StartSessionsStatisticsAggregation(farm);
 *
 * // runtime
 * const { aggregationId } = yield* startAggregation({
 *   resourceIds: { queueIds: [queueId] },
 *   startTime: new Date(Date.now() - 24 * 3600 * 1000),
 *   endTime: new Date(),
 *   groupBy: ["QUEUE_ID"],
 *   statistics: ["SUM"],
 * });
 * ```
 */
export interface StartSessionsStatisticsAggregation extends Binding.Service<
  StartSessionsStatisticsAggregation,
  "AWS.Deadline.StartSessionsStatisticsAggregation",
  (
    farm: Farm,
  ) => Effect.Effect<
    (
      request: Omit<
        deadline.StartSessionsStatisticsAggregationRequest,
        "farmId"
      >,
    ) => Effect.Effect<
      deadline.StartSessionsStatisticsAggregationResponse,
      deadline.StartSessionsStatisticsAggregationError
    >
  >
> {}
export const StartSessionsStatisticsAggregation =
  Binding.Service<StartSessionsStatisticsAggregation>(
    "AWS.Deadline.StartSessionsStatisticsAggregation",
  );
