import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Repository the host lists (roles/artifactregistry.reader on it). */
export const Images = GCP.ArtifactRegistry.Repository("Images", {
  location: "us-central1",
  format: "DOCKER",
});

/**
 * Effect-native Cloud Run service exercising every Artifact Registry
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class ArtifactRegistryBindingsHost extends GCP.Function<ArtifactRegistryBindingsHost>()(
  "ArtifactRegistryBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const listImages = yield* GCP.ArtifactRegistry.ListDockerImages(Images);

    return {
      fetch: serveProbes({
        listDockerImages: listImages({ pageSize: 10 }),
      }),
    };
  }).pipe(Effect.provide(GCP.ArtifactRegistry.ListDockerImagesHttp)),
) {}
