import type * as config from "@distilled.cloud/aws/config-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `config:GetComplianceSummaryByResourceType` — read
 * the count of compliant vs. noncompliant resources, optionally grouped by
 * resource type.
 *
 * Provide `Config.GetComplianceSummaryByResourceTypeHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Reading Compliance
 * @example Summarize Resource Compliance
 * ```typescript
 * // init — grants config:GetComplianceSummaryByResourceType
 * const getComplianceSummaryByResourceType = yield* AWS.Config.GetComplianceSummaryByResourceType();
 *
 * // runtime
 * const result = yield* getComplianceSummaryByResourceType();
 * console.log(result.ComplianceSummariesByResourceType);
 * ```
 */
export interface GetComplianceSummaryByResourceType extends Binding.Service<
  GetComplianceSummaryByResourceType,
  "AWS.Config.GetComplianceSummaryByResourceType",
  () => Effect.Effect<
    (
      request?: config.GetComplianceSummaryByResourceTypeRequest,
    ) => Effect.Effect<
      config.GetComplianceSummaryByResourceTypeResponse,
      config.GetComplianceSummaryByResourceTypeError
    >
  >
> {}

export const GetComplianceSummaryByResourceType =
  Binding.Service<GetComplianceSummaryByResourceType>(
    "AWS.Config.GetComplianceSummaryByResourceType",
  );
