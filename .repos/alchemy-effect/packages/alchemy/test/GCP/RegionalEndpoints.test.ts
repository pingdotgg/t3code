import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Region from "@distilled.cloud/gcp/Region";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({
  providers: GCP.providers().pipe(
    Layer.provideMerge(GCP.Region("us-east4")),
    Layer.provideMerge(GCP.RegionalEndpoints("prefer")),
  ),
});

test.provider(
  "GCP.RegionalEndpoints('prefer') on the providers layer deploys through the regional endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const repo = yield* stack.deploy(
        GCP.ArtifactRegistry.Repository("PreferRepo", { format: "DOCKER" }),
      );
      expect(repo.name).toContain("/locations/us-east4/");
      // The same resource is reachable through the regional host directly.
      const live = yield* artifactregistry
        .getProjectsLocationsRepositories({ name: repo.name })
        .pipe(Effect.provide(Region.regionalEndpoints("prefer")));
      expect(live.name).toEqual(repo.name);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
    timeout: 180_000,
  },
);
