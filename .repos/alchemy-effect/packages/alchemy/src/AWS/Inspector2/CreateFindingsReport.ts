import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:CreateFindingsReport`.
 *
 * Creates a finding report. By default only `ACTIVE` findings are returned in
 * the report. To see `SUPRESSED` or `CLOSED` findings you must specify
 * a value for the `findingStatus` filter criteria.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.CreateFindingsReportHttp)`.
 * @binding
 * @section Findings Reports & SBOM Exports
 * @example Export Findings to S3
 * ```typescript
 * // init
 * const createFindingsReport = yield* AWS.Inspector2.CreateFindingsReport();
 *
 * // runtime
 * const { reportId } = yield* createFindingsReport({
 *   reportFormat: "JSON",
 *   s3Destination: { bucketName, keyPrefix: "findings/", kmsKeyArn },
 * });
 * ```
 */
export interface CreateFindingsReport extends Binding.Service<
  CreateFindingsReport,
  "AWS.Inspector2.CreateFindingsReport",
  () => Effect.Effect<
    (
      request: inspector2.CreateFindingsReportRequest,
    ) => Effect.Effect<
      inspector2.CreateFindingsReportResponse,
      inspector2.CreateFindingsReportError
    >
  >
> {}
export const CreateFindingsReport = Binding.Service<CreateFindingsReport>(
  "AWS.Inspector2.CreateFindingsReport",
);
