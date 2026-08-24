import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:ListAssessmentReports`.
 *
 * Lists the assessment reports created in the account. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListAssessmentReportsHttp)`.
 * @binding
 * @section Assessment Reports
 * @example List Assessment Reports
 * ```typescript
 * const listAssessmentReports = yield* AWS.AuditManager.ListAssessmentReports();
 * const result = yield* listAssessmentReports({ maxResults: 20 });
 * ```
 */
export interface ListAssessmentReports extends Binding.Service<
  ListAssessmentReports,
  "AWS.AuditManager.ListAssessmentReports",
  () => Effect.Effect<
    (
      request?: auditmanager.ListAssessmentReportsRequest,
    ) => Effect.Effect<
      auditmanager.ListAssessmentReportsResponse,
      auditmanager.ListAssessmentReportsError
    >
  >
> {}

export const ListAssessmentReports = Binding.Service<ListAssessmentReports>(
  "AWS.AuditManager.ListAssessmentReports",
);
