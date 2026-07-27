import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `UpdateAssessmentControl` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface UpdateAssessmentControlRequest extends Omit<
  auditmanager.UpdateAssessmentControlRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:UpdateAssessmentControl`.
 *
 * Updates a control within the bound assessment — sets its review
 * status and/or adds a comment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.UpdateAssessmentControlHttp)`.
 * @binding
 * @section Assessment Workflow
 * @example Set a Control's Review Status
 * ```typescript
 * const updateAssessmentControl = yield* AWS.AuditManager.UpdateAssessmentControl(assessment);
 * const result = yield* updateAssessmentControl({ controlSetId, controlId, controlStatus: "REVIEWED" });
 * ```
 */
export interface UpdateAssessmentControl extends Binding.Service<
  UpdateAssessmentControl,
  "AWS.AuditManager.UpdateAssessmentControl",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: UpdateAssessmentControlRequest,
    ) => Effect.Effect<
      auditmanager.UpdateAssessmentControlResponse,
      auditmanager.UpdateAssessmentControlError
    >
  >
> {}

export const UpdateAssessmentControl = Binding.Service<UpdateAssessmentControl>(
  "AWS.AuditManager.UpdateAssessmentControl",
);
