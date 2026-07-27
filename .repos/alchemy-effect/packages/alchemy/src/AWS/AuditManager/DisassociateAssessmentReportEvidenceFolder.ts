import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `DisassociateAssessmentReportEvidenceFolder` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface DisassociateAssessmentReportEvidenceFolderRequest extends Omit<
  auditmanager.DisassociateAssessmentReportEvidenceFolderRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:DisassociateAssessmentReportEvidenceFolder`.
 *
 * Removes an evidence folder from the (in-progress) assessment
 * report of the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.DisassociateAssessmentReportEvidenceFolderHttp)`.
 * @binding
 * @section Assessment Reports
 * @example Exclude an Evidence Folder from the Report
 * ```typescript
 * const disassociateAssessmentReportEvidenceFolder = yield* AWS.AuditManager.DisassociateAssessmentReportEvidenceFolder(assessment);
 * const result = yield* disassociateAssessmentReportEvidenceFolder({ evidenceFolderId });
 * ```
 */
export interface DisassociateAssessmentReportEvidenceFolder extends Binding.Service<
  DisassociateAssessmentReportEvidenceFolder,
  "AWS.AuditManager.DisassociateAssessmentReportEvidenceFolder",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: DisassociateAssessmentReportEvidenceFolderRequest,
    ) => Effect.Effect<
      auditmanager.DisassociateAssessmentReportEvidenceFolderResponse,
      auditmanager.DisassociateAssessmentReportEvidenceFolderError
    >
  >
> {}

export const DisassociateAssessmentReportEvidenceFolder =
  Binding.Service<DisassociateAssessmentReportEvidenceFolder>(
    "AWS.AuditManager.DisassociateAssessmentReportEvidenceFolder",
  );
