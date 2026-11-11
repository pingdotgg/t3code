import * as privateca from "@distilled.cloud/gcp/privateca_v1";
import * as Layer from "effect/Layer";
import { makeCertificateAuthorityHttpBinding } from "./BindingHttp.ts";
import { GetCertificateAuthority } from "./GetCertificateAuthority.ts";

/**
 * HTTP implementation of {@link GetCertificateAuthority}.
 *
 * @layer
 * @provides GCP.PrivateCA.GetCertificateAuthority
 */
export const GetCertificateAuthorityHttp = Layer.effect(
  GetCertificateAuthority,
  makeCertificateAuthorityHttpBinding({
    tag: "GCP.PrivateCA.GetCertificateAuthority",
    iam: { role: "roles/privateca.auditor", on: "privateca.caPool" },
    operation: privateca.getProjectsLocationsCaPoolsCertificateAuthorities,
  }),
);
