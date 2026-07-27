import type * as acm from "@distilled.cloud/aws/acm";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface SearchCertificatesRequest
  extends acm.SearchCertificatesRequest {}

/**
 * Runtime binding for `acm:SearchCertificates`.
 *
 * An account-level operation (no certificate argument) that searches the ACM
 * certificates in `us-east-1` with richer filtering than
 * {@link ListCertificates} — X.509 attributes, status, type, and renewal
 * eligibility can be combined in a filter statement. Provide the
 * implementation with `Effect.provide(AWS.ACM.SearchCertificatesHttp)`.
 * @binding
 * @section Inspecting Certificates
 * @example Search Certificates by ARN
 * ```typescript
 * // init — account-level binding takes no resource
 * const searchCertificates = yield* AWS.ACM.SearchCertificates();
 *
 * // runtime
 * const result = yield* searchCertificates({
 *   FilterStatement: { Filter: { CertificateArn: certificateArn } },
 * });
 * const arns = (result.Results ?? []).map((r) => r.CertificateArn);
 * ```
 */
export interface SearchCertificates extends Binding.Service<
  SearchCertificates,
  "AWS.ACM.SearchCertificates",
  () => Effect.Effect<
    (
      request?: SearchCertificatesRequest,
    ) => Effect.Effect<
      acm.SearchCertificatesResponse,
      acm.SearchCertificatesError
    >
  >
> {}

export const SearchCertificates = Binding.Service<SearchCertificates>(
  "AWS.ACM.SearchCertificates",
);
