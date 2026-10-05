import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** CA pool the bindings are granted on. */
export const Pool = GCP.PrivateCA.CaPool("AppCa", {
  location: "us-central1",
  tier: "DEVOPS",
  publishingOptions: { publishCaCert: false, publishCrl: false },
});

/** Enabled self-signed root CA in {@link Pool}. */
export const Root = Effect.gen(function* () {
  const pool = yield* Pool;
  return yield* GCP.PrivateCA.CertificateAuthority("Root", {
    caPool: pool.name,
    type: "SELF_SIGNED",
    keySpec: { algorithm: "RSA_PKCS1_2048_SHA256" },
  });
});

/**
 * Effect-native Cloud Run service exercising every Private CA binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class PrivateCaBindingsHost extends GCP.Function<PrivateCaBindingsHost>()(
  "PrivateCaBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const fetchCaCerts = yield* GCP.PrivateCA.FetchCaCerts(Pool);
    const getCa = yield* GCP.PrivateCA.GetCertificateAuthority(Root);

    return {
      fetch: serveProbes({
        fetchCaCerts: fetchCaCerts(),
        getCertificateAuthority: getCa(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.PrivateCA.FetchCaCertsHttp),
    Effect.provide(GCP.PrivateCA.GetCertificateAuthorityHttp),
  ),
) {}
