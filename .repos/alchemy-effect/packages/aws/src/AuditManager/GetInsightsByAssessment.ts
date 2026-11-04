import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Assessment } from "./Assessment.ts";

/** `GetInsightsByAssessment` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetInsightsByAssessmentRequest extends Omit<
  auditmanager.GetInsightsByAssessmentRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetInsightsByAssessment`.
 *
 * Gets the latest analytics data for the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetInsightsByAssessmentHttp)`.
 * ### Insights
 * **Example:** Insights for the Bound Assessment
 * ```typescript
 * const getInsightsByAssessment = yield* AWS.AuditManager.GetInsightsByAssessment(assessment);
 * const result = yield* getInsightsByAssessment();
 * ```
 *
 * @binding
 */
export interface GetInsightsByAssessment extends Binding.Service<
  GetInsightsByAssessment,
  "AWS.AuditManager.GetInsightsByAssessment",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request?: GetInsightsByAssessmentRequest,
    ) => Effect.Effect<
      auditmanager.GetInsightsByAssessmentResponse,
      auditmanager.GetInsightsByAssessmentError
    >
  >
> {}

export const GetInsightsByAssessment = Binding.Service<GetInsightsByAssessment>(
  "AWS.AuditManager.GetInsightsByAssessment",
);
