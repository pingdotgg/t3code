import type * as guardduty from "@distilled.cloud/aws/guardduty";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `guardduty:GetOrganizationStatistics`.
 *
 * Reports organization-wide GuardDuty enablement statistics (delegated administrator only).
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.GuardDuty.GetOrganizationStatisticsHttp)`.
 * @binding
 * @section Organization Administration
 * @example Read Org Statistics
 * ```typescript
 * // init
 * // init — account-level binding, no resource argument
 * const getOrganizationStatistics = yield* AWS.GuardDuty.GetOrganizationStatistics();
 *
 * // runtime
 * const { OrganizationDetails } = yield* getOrganizationStatistics();
 * ```
 */
export interface GetOrganizationStatistics extends Binding.Service<
  GetOrganizationStatistics,
  "AWS.GuardDuty.GetOrganizationStatistics",
  () => Effect.Effect<
    (
      request?: guardduty.GetOrganizationStatisticsRequest,
    ) => Effect.Effect<
      guardduty.GetOrganizationStatisticsResponse,
      guardduty.GetOrganizationStatisticsError
    >
  >
> {}
export const GetOrganizationStatistics =
  Binding.Service<GetOrganizationStatistics>(
    "AWS.GuardDuty.GetOrganizationStatistics",
  );
