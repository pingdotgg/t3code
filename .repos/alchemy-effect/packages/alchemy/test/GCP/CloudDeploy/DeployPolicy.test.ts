import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as clouddeploy from "@distilled.cloud/gcp/clouddeploy_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const weekendFreeze = {
  selectors: [{ target: { id: "*" } }],
  rules: [
    {
      rolloutRestriction: {
        id: "weekends",
        timeWindows: {
          timeZone: "America/Los_Angeles",
          weeklyWindows: [{ daysOfWeek: ["SATURDAY", "SUNDAY"] }],
        },
      },
    },
  ],
};

const waitUntilGone = (name: string) =>
  clouddeploy.getProjectsLocationsDeployPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDeployPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        clouddeploy.getProjectsLocationsDeployPolicies({
          name: `projects/${project}/locations/us-central1/deployPolicies/alchemy-missing-policy`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:clouddeploy", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a deploy policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudDeploy.DeployPolicy("Freeze", {
            ...weekendFreeze,
            description: "alchemy-test-policy",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/deployPolicies/");
      expect(created.deployPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("alchemy-test-policy");
      expect(created.selectors[0]?.target?.id).toEqual("*");
      expect(created.rules[0]?.rolloutRestriction?.id).toEqual("weekends");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.suspended).toEqual(false);

      const fetched = yield* clouddeploy.getProjectsLocationsDeployPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("alchemy-test-policy");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudDeploy.DeployPolicy("Freeze", {
            deployPolicyId: created.deployPolicyId,
            ...weekendFreeze,
            description: "alchemy-prod-policy",
            labels: { env: "prod", role: "freeze" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-policy");
      expect(updated.labels).toMatchObject({ env: "prod", role: "freeze" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:clouddeploy", "live"],
    timeout: 90_000,
  },
);
