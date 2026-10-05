import type * as privateca from "@distilled.cloud/gcp/privateca_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { CertificateAuthority } from "./CertificateAuthority.ts";

export interface GetCertificateAuthorityRequest extends Omit<
  privateca.GetProjectsLocationsCaPoolsCertificateAuthoritiesRequest,
  "name"
> {}

/**
 * Runtime binding for Certificate Authority Service
 * `certificateAuthorities.get`.
 *
 * Bind this operation to a {@link CertificateAuthority} in a Function/Action
 * init phase. Provide {@link GetCertificateAuthorityHttp}.
 *
 * ### Observing Certificate Authorities
 * **Example:** Read the bound CA
 * ```typescript
 * const getCa = yield* GCP.PrivateCA.GetCertificateAuthority(root);
 * const live = yield* getCa();
 * ```
 *
 * @binding
 * @category PrivateCA
 */
export interface GetCertificateAuthority extends Binding.Service<
  GetCertificateAuthority,
  "GCP.PrivateCA.GetCertificateAuthority",
  (
    ca: CertificateAuthority,
  ) => Effect.Effect<
    (
      request?: GetCertificateAuthorityRequest,
    ) => Effect.Effect<
      privateca.CertificateAuthority,
      privateca.GetProjectsLocationsCaPoolsCertificateAuthoritiesError,
      RuntimeContext
    >
  >
> {}

export const GetCertificateAuthority = Binding.Service<GetCertificateAuthority>(
  "GCP.PrivateCA.GetCertificateAuthority",
);
