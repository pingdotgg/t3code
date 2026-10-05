import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/gcp/config_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  config.getProjectsLocationsDeploymentGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDeploymentGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        config.getProjectsLocationsDeploymentGroups({
          name: `projects/${project}/locations/us-central1/deploymentGroups/alchemy-missing-group`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:config", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a deployment group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Config.DeploymentGroup("App", {
            deploymentUnits: [{ id: "network", dependencies: [] }],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/deploymentGroups/");
      expect(created.deploymentGroupId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.deploymentUnits[0]?.id).toEqual("network");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* config.getProjectsLocationsDeploymentGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.deploymentUnits?.[0]?.id).toEqual("network");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Config.DeploymentGroup("App", {
            deploymentGroupId: created.deploymentGroupId,
            deploymentUnits: [
              { id: "network", dependencies: [] },
              { id: "cluster", dependencies: ["network"] },
            ],
            labels: { env: "prod", role: "config" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.deploymentUnits.map((unit) => unit.id)).toEqual([
        "network",
        "cluster",
      ]);
      expect(updated.labels).toMatchObject({ env: "prod", role: "config" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:config", "live"], timeout: 90_000 },
);
