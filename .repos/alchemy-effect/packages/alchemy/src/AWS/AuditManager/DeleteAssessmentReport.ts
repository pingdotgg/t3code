import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `DeleteAssessmentReport` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface DeleteAssessmentReportRequest extends Omit<
  auditmanager.DeleteAssessmentReportRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:DeleteAssessmentReport`.
 *
 * Deletes an assessment report from the bound assessment and its S3
 * destination. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.DeleteAssessmentReportHttp)`.
 * @binding
 * @section Assessment Reports
 * @example Delete an Assessment Report
 * ```typescript
 * const deleteAssessmentReport = yield* AWS.AuditManager.DeleteAssessmentReport(assessment);
 * const result = yield* deleteAssessmentReport({ assessmentReportId });
 * ```
 */
export interface DeleteAssessmentReport extends Binding.Service<
  DeleteAssessmentReport,
  "AWS.AuditManager.DeleteAssessmentReport",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: DeleteAssessmentReportRequest,
    ) => Effect.Effect<
      auditmanager.DeleteAssessmentReportResponse,
      auditmanager.DeleteAssessmentReportError
    >
  >
> {}

export const DeleteAssessmentReport = Binding.Service<DeleteAssessmentReport>(
  "AWS.AuditManager.DeleteAssessmentReport",
);
