import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:SearchInsights`.
 *
 * Searches the account's insights within a start-time range, filtered by severity, status, service, or resource collection. The service
 * requires both `FromTime` and `ToTime` on the range.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.SearchInsightsHttp)`.
 * @binding
 * @section Inspecting Insights
 * @example Search Insights by Severity
 * ```typescript
 * // init — account-level binding, no resource argument
 * const searchInsights = yield* AWS.DevOpsGuru.SearchInsights();
 *
 * // runtime
 * const { ReactiveInsights } = yield* searchInsights({
 *   Type: "REACTIVE",
 *   StartTimeRange: {
 *     FromTime: new Date(Date.now() - 24 * 3600_000),
 *     ToTime: new Date(),
 *   },
 *   Filters: { Severities: ["HIGH"] },
 * });
 * yield* Effect.log(`high severity: ${ReactiveInsights?.length}`);
 * ```
 */
export interface SearchInsights extends Binding.Service<
  SearchInsights,
  "AWS.DevOpsGuru.SearchInsights",
  () => Effect.Effect<
    (
      request: devopsguru.SearchInsightsRequest,
    ) => Effect.Effect<
      devopsguru.SearchInsightsResponse,
      devopsguru.SearchInsightsError
    >
  >
> {}
export const SearchInsights = Binding.Service<SearchInsights>(
  "AWS.DevOpsGuru.SearchInsights",
);
