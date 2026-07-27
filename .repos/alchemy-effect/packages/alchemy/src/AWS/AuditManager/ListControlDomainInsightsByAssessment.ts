import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `ListControlDomainInsightsByAssessment` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface ListControlDomainInsightsByAssessmentRequest extends Omit<
  auditmanager.ListControlDomainInsightsByAssessmentRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:ListControlDomainInsightsByAssessment`.
 *
 * Lists the latest analytics data for control domains within the
 * bound (active) assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListControlDomainInsightsByAssessmentHttp)`.
 * @binding
 * @section Insights
 * @example Control-Domain Insights for the Assessment
 * ```typescript
 * const listControlDomainInsightsByAssessment = yield* AWS.AuditManager.ListControlDomainInsightsByAssessment(assessment);
 * const result = yield* listControlDomainInsightsByAssessment({ maxResults: 20 });
 * ```
 */
export interface ListControlDomainInsightsByAssessment extends Binding.Service<
  ListControlDomainInsightsByAssessment,
  "AWS.AuditManager.ListControlDomainInsightsByAssessment",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request?: ListControlDomainInsightsByAssessmentRequest,
    ) => Effect.Effect<
      auditmanager.ListControlDomainInsightsByAssessmentResponse,
      auditmanager.ListControlDomainInsightsByAssessmentError
    >
  >
> {}

export const ListControlDomainInsightsByAssessment =
  Binding.Service<ListControlDomainInsightsByAssessment>(
    "AWS.AuditManager.ListControlDomainInsightsByAssessment",
  );
