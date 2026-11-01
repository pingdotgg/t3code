import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { TEST_ATTESTATION, TEST_POD, TEST_RESOURCE_URI } from "../common.ts";

const Authority = GCP.ContainerAnalysis.Note("Authority", {
  shortDescription: "binding attestor",
  attestation: { hint: { humanReadableName: "Alchemy Bind" } },
});

/** Attestor the host reads (roles/binaryauthorization.attestorsViewer). */
export const Viewed = Effect.gen(function* () {
  const note = yield* Authority;
  return yield* GCP.BinaryAuthorization.Attestor("Viewed", {
    noteReference: note.name,
  });
});

/** Attestor the host verifies against (roles/binaryauthorization.attestorsVerifier). */
export const Verifier = Effect.gen(function* () {
  const note = yield* Authority;
  return yield* GCP.BinaryAuthorization.Attestor("Verifier", {
    noteReference: note.name,
  });
});

/** GKE platform policy the host reads and evaluates (project-level roles). */
export const GkePolicy = GCP.BinaryAuthorization.PlatformsPolicy("Gke", {
  gkePolicy: {},
});

/**
 * Effect-native Cloud Run service exercising every Binary Authorization
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class BinaryAuthorizationBindingsHost extends GCP.Function<BinaryAuthorizationBindingsHost>()(
  "BinaryAuthorizationBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getAttestor = yield* GCP.BinaryAuthorization.GetAttestor(Viewed);
    const validate =
      yield* GCP.BinaryAuthorization.ValidateAttestation(Verifier);
    const getPolicy =
      yield* GCP.BinaryAuthorization.GetPlatformsPolicy(GkePolicy);
    const evaluate =
      yield* GCP.BinaryAuthorization.EvaluateGkePolicy(GkePolicy);

    return {
      fetch: serveProbes({
        getAttestor: getAttestor(),
        validateAttestation: validate({
          occurrenceResourceUri: TEST_RESOURCE_URI,
          attestation: TEST_ATTESTATION,
        }),
        getPlatformsPolicy: getPolicy(),
        evaluateGkePolicy: evaluate({ resource: TEST_POD }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.BinaryAuthorization.GetAttestorHttp),
    Effect.provide(GCP.BinaryAuthorization.ValidateAttestationHttp),
    Effect.provide(GCP.BinaryAuthorization.GetPlatformsPolicyHttp),
    Effect.provide(GCP.BinaryAuthorization.EvaluateGkePolicyHttp),
  ),
) {}
