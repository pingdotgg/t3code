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

const waitUntilGone = (name: string) =>
  clouddeploy.getProjectsLocationsTargets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsTargets on a missing target fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        clouddeploy.getProjectsLocationsTargets({
          name: `projects/${project}/locations/us-central1/targets/alchemy-missing-target`,
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
  "create, update, and delete a Cloud Run target",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const runLocation = `projects/${project}/locations/us-central1`;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudDeploy.Target("Prod", {
            run: { location: runLocation },
            description: "alchemy-test-target",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/targets/");
      expect(created.targetId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("alchemy-test-target");
      expect(created.run?.location).toEqual(runLocation);
      expect(created.requireApproval).toEqual(false);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* clouddeploy.getProjectsLocationsTargets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("alchemy-test-target");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.run?.location).toEqual(runLocation);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudDeploy.Target("Prod", {
            targetId: created.targetId,
            run: { location: runLocation },
            requireApproval: true,
            description: "alchemy-prod-target",
            labels: { env: "prod", role: "run" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-target");
      expect(updated.requireApproval).toEqual(true);
      expect(updated.labels).toMatchObject({ env: "prod", role: "run" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:clouddeploy", "live"],
    timeout: 90_000,
  },
);
