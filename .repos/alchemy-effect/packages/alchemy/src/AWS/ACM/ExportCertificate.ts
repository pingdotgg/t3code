import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * The export request without the injected `CertificateArn`.
 *
 * `Passphrase` encrypts the exported private key and is sensitive — pass it
 * as `Redacted.make(new TextEncoder().encode(passphrase))` so it never leaks
 * into logs or traces.
 */
export interface ExportCertificateRequest extends Omit<
  acm.ExportCertificateRequest,
  "CertificateArn"
> {}

/**
 * Runtime binding for `acm:ExportCertificate`.
 *
 * Bind this operation to a {@link Certificate} to get a callable that exports
 * the certificate, its chain, and the **encrypted private key**. Only
 * exportable certificates can be exported: private-CA certificates, or public
 * certificates requested with `export: "ENABLED"`. The returned `PrivateKey`
 * is sensitive and comes back wrapped in `Redacted` — unwrap it with
 * `Redacted.value` only at the point of use. Provide the implementation with
 * `Effect.provide(AWS.ACM.ExportCertificateHttp)`.
 * @binding
 * @section Exporting Certificates
 * @example Export a Certificate and Its Private Key
 * ```typescript
 * // init — bind the operation to the certificate
 * const exportCertificate = yield* AWS.ACM.ExportCertificate(certificate);
 *
 * // runtime — the passphrase encrypts the exported private key
 * const result = yield* exportCertificate({
 *   Passphrase: Redacted.make(new TextEncoder().encode(passphrase)),
 * });
 * const pem = result.Certificate;
 * const privateKeyPem =
 *   typeof result.PrivateKey === "string"
 *     ? result.PrivateKey
 *     : result.PrivateKey && Redacted.value(result.PrivateKey);
 * ```
 */
export interface ExportCertificate extends Binding.Service<
  ExportCertificate,
  "AWS.ACM.ExportCertificate",
  (
    certificate: Certificate,
  ) => Effect.Effect<
    (
      request: ExportCertificateRequest,
    ) => Effect.Effect<
      acm.ExportCertificateResponse,
      acm.ExportCertificateError
    >
  >
> {}

export const ExportCertificate = Binding.Service<ExportCertificate>(
  "AWS.ACM.ExportCertificate",
);
