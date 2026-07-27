import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

export interface IssueCertificateRequest extends Omit<
  acmpca.IssueCertificateRequest,
  "CertificateAuthorityArn"
> {}

/**
 * Runtime binding for `acm-pca:IssueCertificate`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to sign
 * certificate signing requests (CSRs) with the CA's private key. Returns
 * the ARN of the issued certificate — retrieve the PEM with the
 * {@link GetCertificate} binding (issuance is asynchronous, so poll while
 * `RequestInProgressException` is observed). Provide
 * `ACMPCA.IssueCertificateHttp` on the Function effect to implement the
 * binding.
 *
 * @binding
 * @section Issuing Certificates
 * @example Sign a CSR
 * ```typescript
 * // init
 * const issueCertificate = yield* ACMPCA.IssueCertificate(ca);
 *
 * // runtime
 * const issued = yield* issueCertificate({
 *   Csr: new TextEncoder().encode(csrPem),
 *   SigningAlgorithm: "SHA256WITHRSA",
 *   Validity: { Type: "DAYS", Value: 7 },
 * });
 * // issued.CertificateArn
 * ```
 */
export interface IssueCertificate extends Binding.Service<
  IssueCertificate,
  "AWS.ACMPCA.IssueCertificate",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    (
      request: IssueCertificateRequest,
    ) => Effect.Effect<
      acmpca.IssueCertificateResponse,
      acmpca.IssueCertificateError
    >
  >
> {}

export const IssueCertificate = Binding.Service<IssueCertificate>(
  "AWS.ACMPCA.IssueCertificate",
);
