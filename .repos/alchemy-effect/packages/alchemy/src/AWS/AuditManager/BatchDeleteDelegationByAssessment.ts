import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `BatchDeleteDelegationByAssessment` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface BatchDeleteDelegationByAssessmentRequest extends Omit<
  auditmanager.BatchDeleteDelegationByAssessmentRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:BatchDeleteDelegationByAssessment`.
 *
 * Deletes a batch of delegations from the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.BatchDeleteDelegationByAssessmentHttp)`.
 * @binding
 * @section Delegations
 * @example Revoke Delegations
 * ```typescript
 * const batchDeleteDelegationByAssessment = yield* AWS.AuditManager.BatchDeleteDelegationByAssessment(assessment);
 * const result = yield* batchDeleteDelegationByAssessment({ delegationIds });
 * ```
 */
export interface BatchDeleteDelegationByAssessment extends Binding.Service<
  BatchDeleteDelegationByAssessment,
  "AWS.AuditManager.BatchDeleteDelegationByAssessment",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: BatchDeleteDelegationByAssessmentRequest,
    ) => Effect.Effect<
      auditmanager.BatchDeleteDelegationByAssessmentResponse,
      auditmanager.BatchDeleteDelegationByAssessmentError
    >
  >
> {}

export const BatchDeleteDelegationByAssessment =
  Binding.Service<BatchDeleteDelegationByAssessment>(
    "AWS.AuditManager.BatchDeleteDelegationByAssessment",
  );
