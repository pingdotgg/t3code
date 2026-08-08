import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `UpdateAssessmentControlSetStatus` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface UpdateAssessmentControlSetStatusRequest extends Omit<
  auditmanager.UpdateAssessmentControlSetStatusRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:UpdateAssessmentControlSetStatus`.
 *
 * Updates the review status of a control set in the bound
 * assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.UpdateAssessmentControlSetStatusHttp)`.
 * @binding
 * @section Assessment Workflow
 * @example Sign Off a Control Set
 * ```typescript
 * const updateAssessmentControlSetStatus = yield* AWS.AuditManager.UpdateAssessmentControlSetStatus(assessment);
 * const result = yield* updateAssessmentControlSetStatus({ controlSetId, status: "REVIEWED", comment: "Signed off" });
 * ```
 */
export interface UpdateAssessmentControlSetStatus extends Binding.Service<
  UpdateAssessmentControlSetStatus,
  "AWS.AuditManager.UpdateAssessmentControlSetStatus",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: UpdateAssessmentControlSetStatusRequest,
    ) => Effect.Effect<
      auditmanager.UpdateAssessmentControlSetStatusResponse,
      auditmanager.UpdateAssessmentControlSetStatusError
    >
  >
> {}

export const UpdateAssessmentControlSetStatus =
  Binding.Service<UpdateAssessmentControlSetStatus>(
    "AWS.AuditManager.UpdateAssessmentControlSetStatus",
  );
