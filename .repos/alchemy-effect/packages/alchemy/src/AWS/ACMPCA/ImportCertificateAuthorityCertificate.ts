import type * as acmpca from "@distilled.cloud/aws/acm-pca";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

export interface ImportCertificateAuthorityCertificateRequest extends Omit<
  acmpca.ImportCertificateAuthorityCertificateRequest,
  "CertificateAuthorityArn"
> {}

/**
 * Runtime binding for `acm-pca:ImportCertificateAuthorityCertificate`.
 *
 * Bind a {@link CertificateAuthority} inside a function runtime to install
 * the CA's signed certificate — the final step of the activation flow
 * (fetch CSR via {@link GetCertificateAuthorityCsr}, sign it, import). This
 * enables workflows where the CA's CSR is signed by an on-premises or
 * external parent CA at runtime. Provide
 * `ACMPCA.ImportCertificateAuthorityCertificateHttp` on the Function effect
 * to implement the binding.
 *
 * @binding
 * @section CA Activation
 * @example Install a Signed CA Certificate
 * ```typescript
 * // init
 * const importCaCertificate =
 *   yield* ACMPCA.ImportCertificateAuthorityCertificate(ca);
 *
 * // runtime
 * yield* importCaCertificate({
 *   Certificate: new TextEncoder().encode(signedCertPem),
 *   CertificateChain: new TextEncoder().encode(chainPem),
 * });
 * ```
 */
export interface ImportCertificateAuthorityCertificate extends Binding.Service<
  ImportCertificateAuthorityCertificate,
  "AWS.ACMPCA.ImportCertificateAuthorityCertificate",
  (
    certificateAuthority: CertificateAuthority,
  ) => Effect.Effect<
    (
      request: ImportCertificateAuthorityCertificateRequest,
    ) => Effect.Effect<
      acmpca.ImportCertificateAuthorityCertificateResponse,
      acmpca.ImportCertificateAuthorityCertificateError
    >
  >
> {}

export const ImportCertificateAuthorityCertificate =
  Binding.Service<ImportCertificateAuthorityCertificate>(
    "AWS.ACMPCA.ImportCertificateAuthorityCertificate",
  );
