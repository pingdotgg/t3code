import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const waitUntilGone = (projectId: string, rolloutPlan: string) =>
  compute.getRolloutPlans({ project: projectId, rolloutPlan }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const wave = (locations: string[]): compute.RolloutPlanWave => ({
  displayName: "central",
  selectors: [
    {
      locationSelector: {
        includedLocations: locations,
      },
    },
  ],
  validation: {
    type: "time",
    timeBasedValidationMetadata: { waitDuration: "0s" },
  },
});

test.provider(
  "getRolloutPlans on a missing plan fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        compute.getRolloutPlans({
          project,
          rolloutPlan: "alchemy-missing-rollout-plan",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);

test.provider(
  "create, replace, and delete a rollout plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RolloutPlan("Fleet", {
            description: "ops-agent canary",
            locationScope: "ZONAL",
            waves: [wave(["us-central1-a"])],
          });
        }),
      );

      expect(created.rolloutPlanName).toEqual(expect.any(String));
      expect(created.locationScope).toEqual("ZONAL");
      expect(created.description).toEqual("ops-agent canary");
      expect(created.waves.length).toBeGreaterThan(0);

      const fetched = yield* compute.getRolloutPlans({
        project: created.project,
        rolloutPlan: created.rolloutPlanName,
      });
      expect(fetched.name).toEqual(created.rolloutPlanName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("ops-agent canary");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.RolloutPlan("Fleet", {
            rolloutPlanName: created.rolloutPlanName,
            description: "ops-agent rollout",
            locationScope: "ZONAL",
            waves: [wave(["us-central1-a", "us-central1-b"])],
          });
        }),
      );

      expect(updated.rolloutPlanName).toEqual(created.rolloutPlanName);
      expect(updated.description).toEqual("ops-agent rollout");

      const fetchedUpdated = yield* compute.getRolloutPlans({
        project: updated.project,
        rolloutPlan: updated.rolloutPlanName,
      });
      expect(fetchedUpdated.description).toContain("ops-agent rollout");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        created.project,
        created.rolloutPlanName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
