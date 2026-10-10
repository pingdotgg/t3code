import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  artifactregistry.getProjectsLocationsRepositories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ArtifactRegistry.Repository("Images", {
            location: "us-central1",
            format: "DOCKER",
            description: "test docker repository",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/repositories/");
      expect(created.repositoryId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.format).toEqual("DOCKER");
      expect(created.mode).toEqual("STANDARD_REPOSITORY");
      expect(created.description).toEqual("test docker repository");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.immutableTags).toEqual(false);
      expect(created.registryUri).toEqual(expect.any(String));

      const fetched = yield* artifactregistry.getProjectsLocationsRepositories({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.format).toEqual("DOCKER");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("test docker repository");

      const images =
        yield* artifactregistry.listProjectsLocationsRepositoriesDockerImages({
          parent: created.name,
          pageSize: 10,
        });
      expect(images.dockerImages ?? []).toEqual([]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ArtifactRegistry.Repository("Images", {
            repositoryId: created.repositoryId,
            location: "us-central1",
            format: "DOCKER",
            description: "prod docker repository",
            labels: { env: "prod", role: "images" },
            dockerConfig: { immutableTags: true },
            cleanupPolicyDryRun: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("prod docker repository");
      expect(updated.labels).toMatchObject({ env: "prod", role: "images" });
      expect(updated.immutableTags).toEqual(true);
      expect(updated.cleanupPolicyDryRun).toEqual(true);

      const refetched =
        yield* artifactregistry.getProjectsLocationsRepositories({
          name: created.name,
        });
      expect(refetched.description).toEqual("prod docker repository");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("images");
      expect(refetched.dockerConfig?.immutableTags).toEqual(true);
      expect(refetched.cleanupPolicyDryRun).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
    timeout: 90_000,
  },
);
