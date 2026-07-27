import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * Runtime binding for `acm:RenewCertificate`.
 *
 * Bind this operation to a {@link Certificate} to get a callable that forces
 * managed renewal of an eligible certificate — typically an exported
 * certificate whose renewal is not fully automatic. Useful in rotation
 * functions that renew and then re-export a certificate. Provide the
 * implementation with `Effect.provide(AWS.ACM.RenewCertificateHttp)`.
 * @binding
 * @section Renewing Certificates
 * @example Force a Managed Renewal
 * ```typescript
 * // init — bind the operation to the certificate
 * const renewCertificate = yield* AWS.ACM.RenewCertificate(certificate);
 *
 * // runtime
 * yield* renewCertificate();
 * ```
 */
export interface RenewCertificate extends Binding.Service<
  RenewCertificate,
  "AWS.ACM.RenewCertificate",
  (
    certificate: Certificate,
  ) => Effect.Effect<
    () => Effect.Effect<acm.RenewCertificateResponse, acm.RenewCertificateError>
  >
> {}

export const RenewCertificate = Binding.Service<RenewCertificate>(
  "AWS.ACM.RenewCertificate",
);
