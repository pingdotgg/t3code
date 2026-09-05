import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `GetEvidenceFoldersByAssessment` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetEvidenceFoldersByAssessmentRequest extends Omit<
  auditmanager.GetEvidenceFoldersByAssessmentRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetEvidenceFoldersByAssessment`.
 *
 * Lists the evidence folders in the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFoldersByAssessmentHttp)`.
 * @binding
 * @section Reading Evidence
 * @example List the Assessment's Evidence Folders
 * ```typescript
 * const getEvidenceFoldersByAssessment = yield* AWS.AuditManager.GetEvidenceFoldersByAssessment(assessment);
 * const result = yield* getEvidenceFoldersByAssessment({ maxResults: 20 });
 * ```
 */
export interface GetEvidenceFoldersByAssessment extends Binding.Service<
  GetEvidenceFoldersByAssessment,
  "AWS.AuditManager.GetEvidenceFoldersByAssessment",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request?: GetEvidenceFoldersByAssessmentRequest,
    ) => Effect.Effect<
      auditmanager.GetEvidenceFoldersByAssessmentResponse,
      auditmanager.GetEvidenceFoldersByAssessmentError
    >
  >
> {}

export const GetEvidenceFoldersByAssessment =
  Binding.Service<GetEvidenceFoldersByAssessment>(
    "AWS.AuditManager.GetEvidenceFoldersByAssessment",
  );
