import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `inspector2:ListCoverageStatistics`.
 *
 * Lists Amazon Inspector coverage statistics for your environment.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListCoverageStatisticsHttp)`.
 * ### Coverage & Vulnerability Intel
 * **Example:** Coverage Statistics by Resource Type
 * ```typescript
 * // init
 * const listCoverageStatistics = yield* AWS.Inspector2.ListCoverageStatistics();
 *
 * // runtime
 * const { countsByGroup, totalCounts } = yield* listCoverageStatistics({ groupBy: "RESOURCE_TYPE" });
 * ```
 *
 * @binding
 */
export interface ListCoverageStatistics extends Binding.Service<
  ListCoverageStatistics,
  "AWS.Inspector2.ListCoverageStatistics",
  () => Effect.Effect<
    (
      request?: inspector2.ListCoverageStatisticsRequest,
    ) => Effect.Effect<
      inspector2.ListCoverageStatisticsResponse,
      inspector2.ListCoverageStatisticsError
    >
  >
> {}
export const ListCoverageStatistics = Binding.Service<ListCoverageStatistics>(
  "AWS.Inspector2.ListCoverageStatistics",
);
