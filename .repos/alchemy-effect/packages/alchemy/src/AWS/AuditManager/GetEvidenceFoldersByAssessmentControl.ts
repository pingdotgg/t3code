import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `GetEvidenceFoldersByAssessmentControl` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetEvidenceFoldersByAssessmentControlRequest extends Omit<
  auditmanager.GetEvidenceFoldersByAssessmentControlRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetEvidenceFoldersByAssessmentControl`.
 *
 * Lists the evidence folders associated with a specific control in
 * the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFoldersByAssessmentControlHttp)`.
 * @binding
 * @section Reading Evidence
 * @example Evidence Folders for a Control
 * ```typescript
 * const getEvidenceFoldersByAssessmentControl = yield* AWS.AuditManager.GetEvidenceFoldersByAssessmentControl(assessment);
 * const result = yield* getEvidenceFoldersByAssessmentControl({ controlSetId, controlId });
 * ```
 */
export interface GetEvidenceFoldersByAssessmentControl extends Binding.Service<
  GetEvidenceFoldersByAssessmentControl,
  "AWS.AuditManager.GetEvidenceFoldersByAssessmentControl",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: GetEvidenceFoldersByAssessmentControlRequest,
    ) => Effect.Effect<
      auditmanager.GetEvidenceFoldersByAssessmentControlResponse,
      auditmanager.GetEvidenceFoldersByAssessmentControlError
    >
  >
> {}

export const GetEvidenceFoldersByAssessmentControl =
  Binding.Service<GetEvidenceFoldersByAssessmentControl>(
    "AWS.AuditManager.GetEvidenceFoldersByAssessmentControl",
  );
