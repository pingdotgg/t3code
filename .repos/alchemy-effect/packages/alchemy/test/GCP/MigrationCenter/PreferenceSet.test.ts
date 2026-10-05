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
  migrationcenter.getProjectsLocationsPreferenceSets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsPreferenceSets on a missing set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsPreferenceSets({
          name: `projects/${project}/locations/us-central1/preferenceSets/alchemy-missing-prefset`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a migration center preference set",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MigrationCenter.PreferenceSet("Prod", {
            location: "us-central1",
            displayName: "prod-gce",
            description: "gce defaults",
          });
        }),
      );

      expect(created.preferenceSetId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/preferenceSets/${created.preferenceSetId}`,
      );
      expect(created.displayName).toEqual("prod-gce");
      expect(created.description).toEqual("gce defaults");
      expect(created.virtualMachinePreferences?.targetProduct).toEqual(
        "COMPUTE_MIGRATION_TARGET_PRODUCT_COMPUTE_ENGINE",
      );

      const fetched = yield* migrationcenter.getProjectsLocationsPreferenceSets(
        { name: created.name },
      );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("prod-gce");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("gce defaults");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MigrationCenter.PreferenceSet("Prod", {
            preferenceSetId: created.preferenceSetId,
            location: "us-central1",
            displayName: "prod-gce-v2",
            description: "gce moderate",
            virtualMachinePreferences: {
              targetProduct: "COMPUTE_MIGRATION_TARGET_PRODUCT_COMPUTE_ENGINE",
              regionPreferences: { preferredRegions: ["us-central1"] },
              sizingOptimizationStrategy:
                "SIZING_OPTIMIZATION_STRATEGY_MODERATE",
              commitmentPlan: "COMMITMENT_PLAN_ONE_YEAR",
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("prod-gce-v2");
      expect(updated.description).toEqual("gce moderate");
      expect(updated.virtualMachinePreferences?.commitmentPlan).toEqual(
        "COMMITMENT_PLAN_ONE_YEAR",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 90_000,
  },
);
