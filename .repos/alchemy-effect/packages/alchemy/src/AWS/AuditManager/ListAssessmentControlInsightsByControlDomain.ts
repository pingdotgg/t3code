import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `ListAssessmentControlInsightsByControlDomain` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface ListAssessmentControlInsightsByControlDomainRequest extends Omit<
  auditmanager.ListAssessmentControlInsightsByControlDomainRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:ListAssessmentControlInsightsByControlDomain`.
 *
 * Lists the latest control insights for a control domain within the
 * bound (active) assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListAssessmentControlInsightsByControlDomainHttp)`.
 * @binding
 * @section Insights
 * @example Control Insights for a Domain in the Assessment
 * ```typescript
 * const listAssessmentControlInsightsByControlDomain = yield* AWS.AuditManager.ListAssessmentControlInsightsByControlDomain(assessment);
 * const result = yield* listAssessmentControlInsightsByControlDomain({ controlDomainId });
 * ```
 */
export interface ListAssessmentControlInsightsByControlDomain extends Binding.Service<
  ListAssessmentControlInsightsByControlDomain,
  "AWS.AuditManager.ListAssessmentControlInsightsByControlDomain",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: ListAssessmentControlInsightsByControlDomainRequest,
    ) => Effect.Effect<
      auditmanager.ListAssessmentControlInsightsByControlDomainResponse,
      auditmanager.ListAssessmentControlInsightsByControlDomainError
    >
  >
> {}

export const ListAssessmentControlInsightsByControlDomain =
  Binding.Service<ListAssessmentControlInsightsByControlDomain>(
    "AWS.AuditManager.ListAssessmentControlInsightsByControlDomain",
  );
