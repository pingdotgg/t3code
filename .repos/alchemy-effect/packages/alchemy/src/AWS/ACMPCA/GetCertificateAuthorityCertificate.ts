import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

/**
 * Runtime binding for `acm-pca:GetCertificateAuthorityCertificate`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to retrieve
 * the CA's own certificate and chain (PEM) — e.g. to build a trust store
 * for mutual-TLS verification of certificates the CA issued. Provide
 * `ACMPCA.GetCertificateAuthorityCertificateHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section Reading the CA Certificate
 * @example Build a Trust Store
 * ```typescript
 * // init
 * const getCaCertificate =
 *   yield* ACMPCA.GetCertificateAuthorityCertificate(ca);
 *
 * // runtime
 * const { Certificate, CertificateChain } = yield* getCaCertificate();
 * ```
 */
export interface GetCertificateAuthorityCertificate extends Binding.Service<
  GetCertificateAuthorityCertificate,
  "AWS.ACMPCA.GetCertificateAuthorityCertificate",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    () => Effect.Effect<
      acmpca.GetCertificateAuthorityCertificateResponse,
      acmpca.GetCertificateAuthorityCertificateError
    >
  >
> {}

export const GetCertificateAuthorityCertificate =
  Binding.Service<GetCertificateAuthorityCertificate>(
    "AWS.ACMPCA.GetCertificateAuthorityCertificate",
  );
