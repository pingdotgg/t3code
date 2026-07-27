import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

export interface DescribeCertificateAuthorityAuditReportRequest extends Omit<
  acmpca.DescribeCertificateAuthorityAuditReportRequest,
  "CertificateAuthorityArn"
> {}

/**
 * Runtime binding for `acm-pca:DescribeCertificateAuthorityAuditReport`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to check
 * the status of an audit report started with
 * {@link CreateCertificateAuthorityAuditReport} (reports are generated
 * asynchronously into S3). Provide
 * `ACMPCA.DescribeCertificateAuthorityAuditReportHttp` on the Function
 * effect to implement the binding.
 *
 * @binding
 * @section Audit Reports
 * @example Poll an Audit Report Until It Succeeds
 * ```typescript
 * // init
 * const describeAuditReport =
 *   yield* ACMPCA.DescribeCertificateAuthorityAuditReport(ca);
 *
 * // runtime
 * const status = yield* describeAuditReport({
 *   AuditReportId: report.AuditReportId!,
 * }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (r) => r.AuditReportStatus !== "CREATING",
 *     times: 10,
 *   }),
 * );
 * ```
 */
export interface DescribeCertificateAuthorityAuditReport extends Binding.Service<
  DescribeCertificateAuthorityAuditReport,
  "AWS.ACMPCA.DescribeCertificateAuthorityAuditReport",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    (
      request: DescribeCertificateAuthorityAuditReportRequest,
    ) => Effect.Effect<
      acmpca.DescribeCertificateAuthorityAuditReportResponse,
      acmpca.DescribeCertificateAuthorityAuditReportError
    >
  >
> {}

export const DescribeCertificateAuthorityAuditReport =
  Binding.Service<DescribeCertificateAuthorityAuditReport>(
    "AWS.ACMPCA.DescribeCertificateAuthorityAuditReport",
  );
