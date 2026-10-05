import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as migrationcenter from "@distilled.cloud/gcp/migrationcenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  migrationcenter.getProjectsLocationsSources({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a migration center source",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MigrationCenter.Source("Assets", {
            location: "us-central1",
            type: "SOURCE_TYPE_CUSTOM",
            displayName: "custom assets",
            description: "inventory feed",
            priority: 1,
          });
        }),
      );

      expect(created.sourceId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/sources/${created.sourceId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.location).toEqual("us-central1");
      expect(created.type).toEqual("SOURCE_TYPE_CUSTOM");
      expect(created.managed ?? false).toEqual(false);
      expect(created.displayName).toEqual("custom assets");
      expect(created.description).toEqual("inventory feed");
      expect(created.priority).toEqual(1);

      const fetched = yield* migrationcenter.getProjectsLocationsSources({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.type).toEqual("SOURCE_TYPE_CUSTOM");
      expect(fetched.displayName).toEqual("custom assets");
      expect(fetched.priority).toEqual(1);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("inventory feed");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MigrationCenter.Source("Assets", {
            sourceId: created.sourceId,
            location: "us-central1",
            type: "SOURCE_TYPE_CUSTOM",
            displayName: "custom assets v2",
            description: "inventory feed v2",
            priority: 10,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.sourceId).toEqual(created.sourceId);
      expect(updated.displayName).toEqual("custom assets v2");
      expect(updated.description).toEqual("inventory feed v2");
      expect(updated.priority).toEqual(10);

      const fetchedUpdate = yield* migrationcenter.getProjectsLocationsSources({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toEqual("custom assets v2");
      expect(fetchedUpdate.priority).toEqual(10);
      expect(fetchedUpdate.description).toContain("inventory feed v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 180_000,
  },
);
