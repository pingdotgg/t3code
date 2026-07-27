import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * Runtime binding for `acm:GetCertificate`.
 *
 * Bind this operation to a {@link Certificate} to get a callable that
 * retrieves the issued certificate body and its certificate chain (both
 * PEM-encoded). The certificate must be issued — a certificate that is still
 * pending validation fails with the typed `RequestInProgressException`.
 * Provide the implementation with `Effect.provide(AWS.ACM.GetCertificateHttp)`.
 * @binding
 * @section Reading Certificates
 * @example Fetch the PEM Certificate Chain
 * ```typescript
 * // init — bind the operation to the certificate
 * const getCertificate = yield* AWS.ACM.GetCertificate(certificate);
 *
 * // runtime
 * const result = yield* getCertificate();
 * const pem = result.Certificate;
 * const chain = result.CertificateChain;
 * ```
 *
 * @example Handle a Certificate That Is Not Issued Yet
 * ```typescript
 * const pem = yield* getCertificate().pipe(
 *   Effect.map((result) => result.Certificate),
 *   Effect.catchTag("RequestInProgressException", () =>
 *     Effect.succeed(undefined),
 *   ),
 * );
 * ```
 */
export interface GetCertificate extends Binding.Service<
  GetCertificate,
  "AWS.ACM.GetCertificate",
  (
    certificate: Certificate,
  ) => Effect.Effect<
    () => Effect.Effect<acm.GetCertificateResponse, acm.GetCertificateError>
  >
> {}

export const GetCertificate = Binding.Service<GetCertificate>(
  "AWS.ACM.GetCertificate",
);
