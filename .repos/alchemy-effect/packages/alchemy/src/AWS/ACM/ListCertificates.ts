import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListCertificatesRequest extends acm.ListCertificatesRequest {}

/**
 * Runtime binding for `acm:ListCertificates`.
 *
 * An account-level operation (no certificate argument) that enumerates the
 * ACM certificates in `us-east-1` — the region where alchemy-managed
 * certificates live. Useful for expiry monitors that sweep every certificate
 * in the account. Note that the default filter only returns `RSA_2048`
 * certificates; pass `Includes.keyTypes` to widen it. Provide the
 * implementation with `Effect.provide(AWS.ACM.ListCertificatesHttp)`.
 * @binding
 * @section Inspecting Certificates
 * @example List Certificates Expiring Soon
 * ```typescript
 * // init — account-level binding takes no resource
 * const listCertificates = yield* AWS.ACM.ListCertificates();
 *
 * // runtime
 * const result = yield* listCertificates({
 *   CertificateStatuses: ["ISSUED"],
 * });
 * const expiring = (result.CertificateSummaryList ?? []).filter(
 *   (summary) =>
 *     summary.NotAfter !== undefined &&
 *     summary.NotAfter.getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000,
 * );
 * ```
 */
export interface ListCertificates extends Binding.Service<
  ListCertificates,
  "AWS.ACM.ListCertificates",
  () => Effect.Effect<
    (
      request?: ListCertificatesRequest,
    ) => Effect.Effect<acm.ListCertificatesResponse, acm.ListCertificatesError>
  >
> {}

export const ListCertificates = Binding.Service<ListCertificates>(
  "AWS.ACM.ListCertificates",
);
