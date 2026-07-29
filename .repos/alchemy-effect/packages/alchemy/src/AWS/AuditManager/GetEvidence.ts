import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `GetEvidence` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetEvidenceRequest extends Omit<
  auditmanager.GetEvidenceRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetEvidence`.
 *
 * Gets a single evidence item from the bound assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetEvidenceHttp)`.
 * @binding
 * @section Reading Evidence
 * @example Get a Single Evidence Item
 * ```typescript
 * const getEvidence = yield* AWS.AuditManager.GetEvidence(assessment);
 * const result = yield* getEvidence({ controlSetId, evidenceFolderId, evidenceId });
 * ```
 */
export interface GetEvidence extends Binding.Service<
  GetEvidence,
  "AWS.AuditManager.GetEvidence",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: GetEvidenceRequest,
    ) => Effect.Effect<
      auditmanager.GetEvidenceResponse,
      auditmanager.GetEvidenceError
    >
  >
> {}

export const GetEvidence = Binding.Service<GetEvidence>(
  "AWS.AuditManager.GetEvidence",
);
