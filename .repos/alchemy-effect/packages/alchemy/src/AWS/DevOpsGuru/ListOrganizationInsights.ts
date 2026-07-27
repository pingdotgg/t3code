import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:ListOrganizationInsights`.
 *
 * Lists insights across the organization's accounts filtered by status and type (management or delegated-administrator account).
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListOrganizationInsightsHttp)`.
 * @binding
 * @section Organization Visibility
 * @example List Insights Across Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listOrganizationInsights = yield* AWS.DevOpsGuru.ListOrganizationInsights();
 *
 * // runtime
 * const { ReactiveInsights } = yield* listOrganizationInsights({
 *   StatusFilter: { Ongoing: { Type: "REACTIVE" } },
 * });
 * yield* Effect.log(`org ongoing: ${ReactiveInsights?.length}`);
 * ```
 */
export interface ListOrganizationInsights extends Binding.Service<
  ListOrganizationInsights,
  "AWS.DevOpsGuru.ListOrganizationInsights",
  () => Effect.Effect<
    (
      request: devopsguru.ListOrganizationInsightsRequest,
    ) => Effect.Effect<
      devopsguru.ListOrganizationInsightsResponse,
      devopsguru.ListOrganizationInsightsError
    >
  >
> {}
export const ListOrganizationInsights =
  Binding.Service<ListOrganizationInsights>(
    "AWS.DevOpsGuru.ListOrganizationInsights",
  );
