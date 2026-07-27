import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * The revoke request without the injected `CertificateArn`.
 */
export interface RevokeCertificateRequest extends Omit<
  acm.RevokeCertificateRequest,
  "CertificateArn"
> {}

/**
 * Runtime binding for `acm:RevokeCertificate`.
 *
 * Bind this operation to a {@link Certificate} to get a callable that revokes
 * a previously exported public certificate — e.g. from a security-automation
 * function reacting to a leaked private key. Revocation is permanent. Provide
 * the implementation with `Effect.provide(AWS.ACM.RevokeCertificateHttp)`.
 * @binding
 * @section Revoking Certificates
 * @example Revoke a Compromised Certificate
 * ```typescript
 * // init — bind the operation to the certificate
 * const revokeCertificate = yield* AWS.ACM.RevokeCertificate(certificate);
 *
 * // runtime
 * yield* revokeCertificate({ RevocationReason: "KEY_COMPROMISE" });
 * ```
 */
export interface RevokeCertificate extends Binding.Service<
  RevokeCertificate,
  "AWS.ACM.RevokeCertificate",
  (
    certificate: Certificate,
  ) => Effect.Effect<
    (
      request: RevokeCertificateRequest,
    ) => Effect.Effect<
      acm.RevokeCertificateResponse,
      acm.RevokeCertificateError
    >
  >
> {}

export const RevokeCertificate = Binding.Service<RevokeCertificate>(
  "AWS.ACM.RevokeCertificate",
);
