import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

export interface RevokeCertificateRequest extends Omit<
  acmpca.RevokeCertificateRequest,
  "CertificateAuthorityArn"
> {}

/**
 * Runtime binding for `acm-pca:RevokeCertificate`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to revoke
 * certificates the CA issued (e.g. on credential compromise). Revoked
 * certificates appear in the CA's CRL/OCSP responses when revocation is
 * configured. The serial number is the hex serial from the issued
 * certificate. Provide `ACMPCA.RevokeCertificateHttp` on the Function
 * effect to implement the binding.
 *
 * @binding
 * @section Revoking Certificates
 * @example Revoke a Compromised Certificate
 * ```typescript
 * // init
 * const revokeCertificate = yield* ACMPCA.RevokeCertificate(ca);
 *
 * // runtime
 * yield* revokeCertificate({
 *   CertificateSerial: serialHex,
 *   RevocationReason: "KEY_COMPROMISE",
 * });
 * ```
 */
export interface RevokeCertificate extends Binding.Service<
  RevokeCertificate,
  "AWS.ACMPCA.RevokeCertificate",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    (
      request: RevokeCertificateRequest,
    ) => Effect.Effect<
      acmpca.RevokeCertificateResponse,
      acmpca.RevokeCertificateError
    >
  >
> {}

export const RevokeCertificate = Binding.Service<RevokeCertificate>(
  "AWS.ACMPCA.RevokeCertificate",
);
