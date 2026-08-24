import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

/**
 * Runtime binding for `acm-pca:GetCertificateAuthorityCsr`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to retrieve
 * the CSR the CA generated at creation. The CSR is the input to the CA
 * activation flow: sign it (self-sign a root via
 * {@link IssueCertificate}, or have an external parent CA sign it), then
 * install the result with {@link ImportCertificateAuthorityCertificate}.
 * Provide `ACMPCA.GetCertificateAuthorityCsrHttp` on the Function effect to
 * implement the binding.
 *
 * @binding
 * @section CA Activation
 * @example Fetch the CA's CSR
 * ```typescript
 * // init
 * const getCsr = yield* ACMPCA.GetCertificateAuthorityCsr(ca);
 *
 * // runtime
 * const { Csr } = yield* getCsr();
 * ```
 */
export interface GetCertificateAuthorityCsr extends Binding.Service<
  GetCertificateAuthorityCsr,
  "AWS.ACMPCA.GetCertificateAuthorityCsr",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    () => Effect.Effect<
      acmpca.GetCertificateAuthorityCsrResponse,
      acmpca.GetCertificateAuthorityCsrError
    >
  >
> {}

export const GetCertificateAuthorityCsr =
  Binding.Service<GetCertificateAuthorityCsr>(
    "AWS.ACMPCA.GetCertificateAuthorityCsr",
  );
