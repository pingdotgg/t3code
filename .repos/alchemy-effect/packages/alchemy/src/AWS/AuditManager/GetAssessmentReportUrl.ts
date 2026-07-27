import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `GetAssessmentReportUrl` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface GetAssessmentReportUrlRequest extends Omit<
  auditmanager.GetAssessmentReportUrlRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:GetAssessmentReportUrl`.
 *
 * Gets the presigned URL for downloading a generated assessment
 * report. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.GetAssessmentReportUrlHttp)`.
 * @binding
 * @section Assessment Reports
 * @example Presign a Report Download
 * ```typescript
 * const getAssessmentReportUrl = yield* AWS.AuditManager.GetAssessmentReportUrl(assessment);
 * const result = yield* getAssessmentReportUrl({ assessmentReportId });
 * ```
 */
export interface GetAssessmentReportUrl extends Binding.Service<
  GetAssessmentReportUrl,
  "AWS.AuditManager.GetAssessmentReportUrl",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: GetAssessmentReportUrlRequest,
    ) => Effect.Effect<
      auditmanager.GetAssessmentReportUrlResponse,
      auditmanager.GetAssessmentReportUrlError
    >
  >
> {}

export const GetAssessmentReportUrl = Binding.Service<GetAssessmentReportUrl>(
  "AWS.AuditManager.GetAssessmentReportUrl",
);
