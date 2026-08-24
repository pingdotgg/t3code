import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `GetEvidenceByEvidenceFolder` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetEvidenceByEvidenceFolderRequest extends Omit<
  auditmanager.GetEvidenceByEvidenceFolderRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetEvidenceByEvidenceFolder`.
 *
 * Lists the evidence collected in an evidence folder of the bound
 * assessment. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetEvidenceByEvidenceFolderHttp)`.
 * @binding
 * @section Reading Evidence
 * @example List the Evidence in a Folder
 * ```typescript
 * const getEvidenceByEvidenceFolder = yield* AWS.AuditManager.GetEvidenceByEvidenceFolder(assessment);
 * const result = yield* getEvidenceByEvidenceFolder({ controlSetId, evidenceFolderId });
 * ```
 */
export interface GetEvidenceByEvidenceFolder extends Binding.Service<
  GetEvidenceByEvidenceFolder,
  "AWS.AuditManager.GetEvidenceByEvidenceFolder",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: GetEvidenceByEvidenceFolderRequest,
    ) => Effect.Effect<
      auditmanager.GetEvidenceByEvidenceFolderResponse,
      auditmanager.GetEvidenceByEvidenceFolderError
    >
  >
> {}

export const GetEvidenceByEvidenceFolder =
  Binding.Service<GetEvidenceByEvidenceFolder>(
    "AWS.AuditManager.GetEvidenceByEvidenceFolder",
  );
