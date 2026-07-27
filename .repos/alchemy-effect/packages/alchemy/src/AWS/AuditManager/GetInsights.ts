import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:GetInsights`.
 *
 * Gets the latest analytics data for all active assessments —
 * compliance-check counts by status across the account. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetInsightsHttp)`.
 * @binding
 * @section Insights
 * @example Account-Wide Evidence Insights
 * ```typescript
 * const getInsights = yield* AWS.AuditManager.GetInsights();
 * const result = yield* getInsights();
 * ```
 */
export interface GetInsights extends Binding.Service<
  GetInsights,
  "AWS.AuditManager.GetInsights",
  () => Effect.Effect<
    (
      request?: auditmanager.GetInsightsRequest,
    ) => Effect.Effect<
      auditmanager.GetInsightsResponse,
      auditmanager.GetInsightsError
    >
  >
> {}

export const GetInsights = Binding.Service<GetInsights>(
  "AWS.AuditManager.GetInsights",
);
