import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:ValidateAssessmentReportIntegrity`.
 *
 * Validates the integrity (checksums) of a generated assessment
 * report in Amazon S3. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ValidateAssessmentReportIntegrityHttp)`.
 * @binding
 * @section Assessment Reports
 * @example Validate a Generated Report
 * ```typescript
 * const validateAssessmentReportIntegrity = yield* AWS.AuditManager.ValidateAssessmentReportIntegrity();
 * const result = yield* validateAssessmentReportIntegrity({ s3RelativePath: "s3://audit-reports/report.zip" });
 * ```
 */
export interface ValidateAssessmentReportIntegrity extends Binding.Service<
  ValidateAssessmentReportIntegrity,
  "AWS.AuditManager.ValidateAssessmentReportIntegrity",
  () => Effect.Effect<
    (
      request: auditmanager.ValidateAssessmentReportIntegrityRequest,
    ) => Effect.Effect<
      auditmanager.ValidateAssessmentReportIntegrityResponse,
      auditmanager.ValidateAssessmentReportIntegrityError
    >
  >
> {}

export const ValidateAssessmentReportIntegrity =
  Binding.Service<ValidateAssessmentReportIntegrity>(
    "AWS.AuditManager.ValidateAssessmentReportIntegrity",
  );
