import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

export interface GetCertificateRequest extends Omit<
  acmpca.GetCertificateRequest,
  "CertificateAuthorityArn"
> {}

/**
 * Runtime binding for `acm-pca:GetCertificate`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to retrieve
 * a certificate previously issued by the CA (via the
 * {@link IssueCertificate} binding). Issuance is asynchronous — retry while
 * the typed `RequestInProgressException` is observed. Provide
 * `ACMPCA.GetCertificateHttp` on the Function effect to implement the
 * binding.
 *
 * @binding
 * @section Retrieving Issued Certificates
 * @example Poll for an Issued Certificate
 * ```typescript
 * // init
 * const getCertificate = yield* ACMPCA.GetCertificate(ca);
 *
 * // runtime
 * const certificate = yield* getCertificate({
 *   CertificateArn: issued.CertificateArn!,
 * }).pipe(
 *   Effect.retry({
 *     while: (e) => e._tag === "RequestInProgressException",
 *     schedule: Schedule.exponential("500 millis"),
 *     times: 8,
 *   }),
 * );
 * // certificate.Certificate / certificate.CertificateChain (PEM)
 * ```
 */
export interface GetCertificate extends Binding.Service<
  GetCertificate,
  "AWS.ACMPCA.GetCertificate",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    (
      request: GetCertificateRequest,
    ) => Effect.Effect<
      acmpca.GetCertificateResponse,
      acmpca.GetCertificateError
    >
  >
> {}

export const GetCertificate = Binding.Service<GetCertificate>(
  "AWS.ACMPCA.GetCertificate",
);
