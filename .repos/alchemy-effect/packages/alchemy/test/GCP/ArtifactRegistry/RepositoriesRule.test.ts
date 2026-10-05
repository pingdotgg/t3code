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
  artifactregistry.getProjectsLocationsRepositoriesRules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a repository download rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const images = yield* GCP.ArtifactRegistry.Repository("Images", {
            location: "us-central1",
            format: "DOCKER",
            description: "rule parent",
          });
          const rule = yield* GCP.ArtifactRegistry.RepositoriesRule("Deny", {
            repository: images.name,
            location: "us-central1",
            action: "ALLOW",
          });
          return { images, rule };
        }),
      );

      expect(created.rule.name).toContain("/rules/");
      expect(created.rule.repository).toEqual(created.images.name);
      expect(created.rule.action).toEqual("ALLOW");
      expect(created.rule.operation).toEqual("DOWNLOAD");
      expect(created.rule.location).toEqual("us-central1");

      const fetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesRules({
          name: created.rule.name,
        });
      expect(fetched.name).toEqual(created.rule.name);
      expect(fetched.action).toEqual("ALLOW");
      expect(fetched.condition?.title).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const images = yield* GCP.ArtifactRegistry.Repository("Images", {
            repositoryId: created.images.repositoryId,
            location: "us-central1",
            format: "DOCKER",
            description: "rule parent",
          });
          const rule = yield* GCP.ArtifactRegistry.RepositoriesRule("Deny", {
            repository: images.name,
            ruleId: created.rule.ruleId,
            location: "us-central1",
            action: "DENY",
            condition: { expression: "pkg.version.id != '9.9.9'" },
          });
          return { images, rule };
        }),
      );

      expect(updated.rule.name).toEqual(created.rule.name);
      expect(updated.rule.action).toEqual("DENY");
      expect(updated.rule.condition?.expression).toEqual(
        "pkg.version.id != '9.9.9'",
      );

      const refetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesRules({
          name: created.rule.name,
        });
      expect(refetched.action).toEqual("DENY");
      expect(refetched.condition?.expression).toEqual(
        "pkg.version.id != '9.9.9'",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.rule.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
    timeout: 90_000,
  },
);
