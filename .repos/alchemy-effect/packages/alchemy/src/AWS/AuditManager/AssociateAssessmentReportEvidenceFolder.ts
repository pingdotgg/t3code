import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `AssociateAssessmentReportEvidenceFolder` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface AssociateAssessmentReportEvidenceFolderRequest extends Omit<
  auditmanager.AssociateAssessmentReportEvidenceFolderRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:AssociateAssessmentReportEvidenceFolder`.
 *
 * Adds an evidence folder to the (in-progress) assessment report of
 * the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.AssociateAssessmentReportEvidenceFolderHttp)`.
 * @binding
 * @section Assessment Reports
 * @example Include an Evidence Folder in the Report
 * ```typescript
 * const associateAssessmentReportEvidenceFolder = yield* AWS.AuditManager.AssociateAssessmentReportEvidenceFolder(assessment);
 * const result = yield* associateAssessmentReportEvidenceFolder({ evidenceFolderId });
 * ```
 */
export interface AssociateAssessmentReportEvidenceFolder extends Binding.Service<
  AssociateAssessmentReportEvidenceFolder,
  "AWS.AuditManager.AssociateAssessmentReportEvidenceFolder",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: AssociateAssessmentReportEvidenceFolderRequest,
    ) => Effect.Effect<
      auditmanager.AssociateAssessmentReportEvidenceFolderResponse,
      auditmanager.AssociateAssessmentReportEvidenceFolderError
    >
  >
> {}

export const AssociateAssessmentReportEvidenceFolder =
  Binding.Service<AssociateAssessmentReportEvidenceFolder>(
    "AWS.AuditManager.AssociateAssessmentReportEvidenceFolder",
  );
