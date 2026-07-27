import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

export interface CreateCertificateAuthorityAuditReportRequest extends Omit<
  acmpca.CreateCertificateAuthorityAuditReportRequest,
  "CertificateAuthorityArn"
> {}

/**
 * Runtime binding for `acm-pca:CreateCertificateAuthorityAuditReport`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to generate
 * an audit report of every private-key use (issue/revoke) into an S3
 * bucket — e.g. from a scheduled compliance function. AWS allows at most
 * one report per CA every 30 minutes. The S3 bucket policy must grant
 * Amazon Web Services Private CA write access. Provide
 * `ACMPCA.CreateCertificateAuthorityAuditReportHttp` on the Function effect
 * to implement the binding.
 *
 * @binding
 * @section Audit Reports
 * @example Generate an Audit Report
 * ```typescript
 * // init
 * const createAuditReport =
 *   yield* ACMPCA.CreateCertificateAuthorityAuditReport(ca);
 *
 * // runtime
 * const report = yield* createAuditReport({
 *   S3BucketName: bucketName,
 *   AuditReportResponseFormat: "JSON",
 * });
 * // report.AuditReportId / report.S3Key
 * ```
 */
export interface CreateCertificateAuthorityAuditReport extends Binding.Service<
  CreateCertificateAuthorityAuditReport,
  "AWS.ACMPCA.CreateCertificateAuthorityAuditReport",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    (
      request: CreateCertificateAuthorityAuditReportRequest,
    ) => Effect.Effect<
      acmpca.CreateCertificateAuthorityAuditReportResponse,
      acmpca.CreateCertificateAuthorityAuditReportError
    >
  >
> {}

export const CreateCertificateAuthorityAuditReport =
  Binding.Service<CreateCertificateAuthorityAuditReport>(
    "AWS.ACMPCA.CreateCertificateAuthorityAuditReport",
  );
