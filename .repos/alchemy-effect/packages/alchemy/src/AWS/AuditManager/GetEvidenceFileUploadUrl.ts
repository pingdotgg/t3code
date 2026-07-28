import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:GetEvidenceFileUploadUrl`.
 *
 * Creates a presigned Amazon S3 URL that can be used to upload a
 * manual-evidence file — pair with
 * {@link BatchImportEvidenceToAssessmentControl} to attach the uploaded
 * file to a control. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetEvidenceFileUploadUrlHttp)`.
 * @binding
 * @section Manual Evidence
 * @example Presign a Manual-Evidence Upload
 * ```typescript
 * const getEvidenceFileUploadUrl = yield* AWS.AuditManager.GetEvidenceFileUploadUrl();
 * const result = yield* getEvidenceFileUploadUrl({ fileName: "access-review.pdf" });
 * ```
 */
export interface GetEvidenceFileUploadUrl extends Binding.Service<
  GetEvidenceFileUploadUrl,
  "AWS.AuditManager.GetEvidenceFileUploadUrl",
  () => Effect.Effect<
    (
      request: auditmanager.GetEvidenceFileUploadUrlRequest,
    ) => Effect.Effect<
      auditmanager.GetEvidenceFileUploadUrlResponse,
      auditmanager.GetEvidenceFileUploadUrlError
    >
  >
> {}

export const GetEvidenceFileUploadUrl =
  Binding.Service<GetEvidenceFileUploadUrl>(
    "AWS.AuditManager.GetEvidenceFileUploadUrl",
  );
