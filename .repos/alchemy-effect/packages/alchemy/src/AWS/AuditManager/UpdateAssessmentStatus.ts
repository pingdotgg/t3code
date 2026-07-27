import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `UpdateAssessmentStatus` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface UpdateAssessmentStatusRequest extends Omit<
  auditmanager.UpdateAssessmentStatusRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:UpdateAssessmentStatus`.
 *
 * Sets the bound assessment's status — mark it `INACTIVE` to
 * complete it and stop evidence collection. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.UpdateAssessmentStatusHttp)`.
 * @binding
 * @section Assessment Workflow
 * @example Complete an Assessment
 * ```typescript
 * const updateAssessmentStatus = yield* AWS.AuditManager.UpdateAssessmentStatus(assessment);
 * const result = yield* updateAssessmentStatus({ status: "INACTIVE" });
 * ```
 */
export interface UpdateAssessmentStatus extends Binding.Service<
  UpdateAssessmentStatus,
  "AWS.AuditManager.UpdateAssessmentStatus",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: UpdateAssessmentStatusRequest,
    ) => Effect.Effect<
      auditmanager.UpdateAssessmentStatusResponse,
      auditmanager.UpdateAssessmentStatusError
    >
  >
> {}

export const UpdateAssessmentStatus = Binding.Service<UpdateAssessmentStatus>(
  "AWS.AuditManager.UpdateAssessmentStatus",
);
