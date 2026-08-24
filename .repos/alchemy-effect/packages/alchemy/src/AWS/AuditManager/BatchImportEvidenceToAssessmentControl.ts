import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `BatchImportEvidenceToAssessmentControl` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface BatchImportEvidenceToAssessmentControlRequest extends Omit<
  auditmanager.BatchImportEvidenceToAssessmentControlRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:BatchImportEvidenceToAssessmentControl`.
 *
 * Adds one or more pieces of manual evidence to a control in the
 * bound assessment — free-form text, an S3 object, or a file uploaded via
 * {@link GetEvidenceFileUploadUrl}. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.BatchImportEvidenceToAssessmentControlHttp)`.
 * @binding
 * @section Manual Evidence
 * @example Attach Manual Evidence to a Control
 * ```typescript
 * const batchImportEvidenceToAssessmentControl = yield* AWS.AuditManager.BatchImportEvidenceToAssessmentControl(assessment);
 * const result = yield* batchImportEvidenceToAssessmentControl({
 *   controlSetId,
 *   controlId,
 *   manualEvidence: [{ textResponse: "Reviewed 2026-Q3: no findings" }],
 * });
 * ```
 */
export interface BatchImportEvidenceToAssessmentControl extends Binding.Service<
  BatchImportEvidenceToAssessmentControl,
  "AWS.AuditManager.BatchImportEvidenceToAssessmentControl",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: BatchImportEvidenceToAssessmentControlRequest,
    ) => Effect.Effect<
      auditmanager.BatchImportEvidenceToAssessmentControlResponse,
      auditmanager.BatchImportEvidenceToAssessmentControlError
    >
  >
> {}

export const BatchImportEvidenceToAssessmentControl =
  Binding.Service<BatchImportEvidenceToAssessmentControl>(
    "AWS.AuditManager.BatchImportEvidenceToAssessmentControl",
  );
