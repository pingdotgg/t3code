import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Assessment } from "./Assessment.ts";

/** `CreateAssessmentReport` request with `assessmentId` injected from the bound {@link Assessment}. */
export interface CreateAssessmentReportRequest extends Omit<
  auditmanager.CreateAssessmentReportRequest,
  "assessmentId"
> {}

/**
 * Runtime binding for `auditmanager:CreateAssessmentReport`.
 *
 * Creates an assessment report — a finalized document generated from
 * the bound assessment's evidence — in the assessment's S3 destination. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.CreateAssessmentReportHttp)`.
 * @binding
 * @section Assessment Reports
 * @example Generate an Assessment Report
 * ```typescript
 * const createAssessmentReport = yield* AWS.AuditManager.CreateAssessmentReport(assessment);
 * const result = yield* createAssessmentReport({ name: "quarterly-report" });
 * ```
 */
export interface CreateAssessmentReport extends Binding.Service<
  CreateAssessmentReport,
  "AWS.AuditManager.CreateAssessmentReport",
  (
    assessment: Assessment,
  ) => Effect.Effect<
    (
      request: CreateAssessmentReportRequest,
    ) => Effect.Effect<
      auditmanager.CreateAssessmentReportResponse,
      auditmanager.CreateAssessmentReportError
    >
  >
> {}

export const CreateAssessmentReport = Binding.Service<CreateAssessmentReport>(
  "AWS.AuditManager.CreateAssessmentReport",
);
