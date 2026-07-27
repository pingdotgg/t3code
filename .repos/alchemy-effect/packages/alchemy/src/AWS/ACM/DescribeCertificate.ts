import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * Runtime binding for `acm:DescribeCertificate`.
 *
 * Bind this operation to a {@link Certificate} to get a callable that reads
 * the certificate's live metadata — status, domain validation state, renewal
 * summary, expiry — from inside a function runtime. Useful for expiry
 * monitors and issuance dashboards. Provide the implementation with
 * `Effect.provide(AWS.ACM.DescribeCertificateHttp)`.
 * @binding
 * @section Inspecting Certificates
 * @example Read a Certificate's Status and Expiry
 * ```typescript
 * // init — bind the operation to the certificate
 * const describeCertificate = yield* AWS.ACM.DescribeCertificate(certificate);
 *
 * // runtime
 * const { Certificate: detail } = yield* describeCertificate();
 * const status = detail?.Status;
 * const notAfter = detail?.NotAfter;
 * ```
 */
export interface DescribeCertificate extends Binding.Service<
  DescribeCertificate,
  "AWS.ACM.DescribeCertificate",
  (
    certificate: Certificate,
  ) => Effect.Effect<
    () => Effect.Effect<
      acm.DescribeCertificateResponse,
      acm.DescribeCertificateError
    >
  >
> {}

export const DescribeCertificate = Binding.Service<DescribeCertificate>(
  "AWS.ACM.DescribeCertificate",
);
