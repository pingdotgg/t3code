import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `BatchAssociateAssessmentReportEvidence` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface BatchAssociateAssessmentReportEvidenceRequest extends Omit<
  auditmanager.BatchAssociateAssessmentReportEvidenceRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:BatchAssociateAssessmentReportEvidence`.
 *
 * Adds a batch of evidence items to the (in-progress) assessment
 * report of the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.BatchAssociateAssessmentReportEvidenceHttp)`.
 * @binding
 * @section Assessment Reports
 * @example Include a Batch of Evidence in the Report
 * ```typescript
 * const batchAssociateAssessmentReportEvidence = yield* AWS.AuditManager.BatchAssociateAssessmentReportEvidence(assessment);
 * const result = yield* batchAssociateAssessmentReportEvidence({ evidenceFolderId, evidenceIds });
 * ```
 */
export interface BatchAssociateAssessmentReportEvidence extends Binding.Service<
  BatchAssociateAssessmentReportEvidence,
  "AWS.AuditManager.BatchAssociateAssessmentReportEvidence",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: BatchAssociateAssessmentReportEvidenceRequest,
    ) => Effect.Effect<
      auditmanager.BatchAssociateAssessmentReportEvidenceResponse,
      auditmanager.BatchAssociateAssessmentReportEvidenceError
    >
  >
> {}

export const BatchAssociateAssessmentReportEvidence =
  Binding.Service<BatchAssociateAssessmentReportEvidence>(
    "AWS.AuditManager.BatchAssociateAssessmentReportEvidence",
  );
