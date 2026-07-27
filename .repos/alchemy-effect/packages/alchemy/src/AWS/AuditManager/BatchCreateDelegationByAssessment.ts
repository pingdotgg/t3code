import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `BatchCreateDelegationByAssessment` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface BatchCreateDelegationByAssessmentRequest extends Omit<
  auditmanager.BatchCreateDelegationByAssessmentRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:BatchCreateDelegationByAssessment`.
 *
 * Creates a batch of delegations — handing control sets of the bound
 * assessment to reviewers. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.BatchCreateDelegationByAssessmentHttp)`.
 * @binding
 * @section Delegations
 * @example Delegate Control Sets for Review
 * ```typescript
 * const batchCreateDelegationByAssessment = yield* AWS.AuditManager.BatchCreateDelegationByAssessment(assessment);
 * const result = yield* batchCreateDelegationByAssessment({
 *   createDelegationRequests: [{
 *     roleArn: reviewerRoleArn,
 *     roleType: "RESOURCE_OWNER",
 *     controlSetId,
 *   }],
 * });
 * ```
 */
export interface BatchCreateDelegationByAssessment extends Binding.Service<
  BatchCreateDelegationByAssessment,
  "AWS.AuditManager.BatchCreateDelegationByAssessment",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: BatchCreateDelegationByAssessmentRequest,
    ) => Effect.Effect<
      auditmanager.BatchCreateDelegationByAssessmentResponse,
      auditmanager.BatchCreateDelegationByAssessmentError
    >
  >
> {}

export const BatchCreateDelegationByAssessment =
  Binding.Service<BatchCreateDelegationByAssessment>(
    "AWS.AuditManager.BatchCreateDelegationByAssessment",
  );
