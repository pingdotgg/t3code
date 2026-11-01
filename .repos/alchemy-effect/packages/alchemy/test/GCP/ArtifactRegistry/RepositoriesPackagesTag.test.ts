import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { IMAGE, pushDockerVersion } from "./registry.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  artifactregistry.getProjectsLocationsRepositoriesPackagesTags({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitForVersion = (name: string) =>
  artifactregistry
    .getProjectsLocationsRepositoriesPackagesVersions({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("missing" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "found",
        times: 10,
      }),
    );

test.provider(
  "create, update, and delete a package tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ArtifactRegistry.Repository("Images", {
            location: "us-central1",
            format: "DOCKER",
            description: "tag parent",
          });
        }),
      );

      const v1 = yield* pushDockerVersion(repo, "v1");
      const v2 = yield* pushDockerVersion(repo, "v2");
      const first = yield* waitForVersion(v1);
      const second = yield* waitForVersion(v2);
      expect(first).toEqual("found");
      expect(second).toEqual("found");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const images = yield* GCP.ArtifactRegistry.Repository("Images", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "DOCKER",
            description: "tag parent",
          });
          const tag = yield* GCP.ArtifactRegistry.RepositoriesPackagesTag(
            "Stable",
            {
              repository: images.name,
              packageId: IMAGE,
              tagId: "stable",
              version: v1,
            },
          );
          return { images, tag };
        }),
      );

      expect(created.tag.name).toContain("/tags/");
      expect(created.tag.tagId).toEqual("stable");
      expect(created.tag.packageId).toEqual(IMAGE);
      expect(created.tag.version).toEqual(v1);

      const fetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesPackagesTags({
          name: created.tag.name,
        });
      expect(fetched.name).toEqual(created.tag.name);
      expect(fetched.version).toEqual(v1);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const images = yield* GCP.ArtifactRegistry.Repository("Images", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "DOCKER",
            description: "tag parent",
          });
          const tag = yield* GCP.ArtifactRegistry.RepositoriesPackagesTag(
            "Stable",
            {
              repository: images.name,
              packageId: IMAGE,
              tagId: "stable",
              version: v2,
            },
          );
          return { images, tag };
        }),
      );

      expect(updated.tag.name).toEqual(created.tag.name);
      expect(updated.tag.version).toEqual(v2);

      const refetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesPackagesTags({
          name: created.tag.name,
        });
      expect(refetched.version).toEqual(v2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.tag.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
    timeout: 90_000,
  },
);
