import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:SearchOrganizationInsights`.
 *
 * Searches insights across specific organization accounts within a start-time range (management or delegated-administrator account). The
 * service requires both `FromTime` and `ToTime` on the range.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.SearchOrganizationInsightsHttp)`.
 * @binding
 * @section Organization Visibility
 * @example Search Insights Across Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const searchOrganizationInsights = yield* AWS.DevOpsGuru.SearchOrganizationInsights();
 *
 * // runtime
 * const { ReactiveInsights } = yield* searchOrganizationInsights({
 *   AccountIds: ["111111111111"],
 *   Type: "REACTIVE",
 *   StartTimeRange: {
 *     FromTime: new Date(Date.now() - 24 * 3600_000),
 *     ToTime: new Date(),
 *   },
 * });
 * yield* Effect.log(`found: ${ReactiveInsights?.length}`);
 * ```
 */
export interface SearchOrganizationInsights extends Binding.Service<
  SearchOrganizationInsights,
  "AWS.DevOpsGuru.SearchOrganizationInsights",
  () => Effect.Effect<
    (
      request: devopsguru.SearchOrganizationInsightsRequest,
    ) => Effect.Effect<
      devopsguru.SearchOrganizationInsightsResponse,
      devopsguru.SearchOrganizationInsightsError
    >
  >
> {}
export const SearchOrganizationInsights =
  Binding.Service<SearchOrganizationInsights>(
    "AWS.DevOpsGuru.SearchOrganizationInsights",
  );
