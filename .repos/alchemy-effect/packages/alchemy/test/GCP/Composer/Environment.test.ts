import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as composer from "@distilled.cloud/gcp/composer_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { defaultComputeServiceAccount } from "./serviceAccount.ts";
import { CAPACITY_REGION } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Composer environments take 20-45 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  composer.getProjectsLocationsEnvironments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsEnvironments on a missing environment fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        composer.getProjectsLocationsEnvironments({
          name: `projects/${project}/locations/${CAPACITY_REGION}/environments/alchemy-composer-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* composer.listProjectsLocationsEnvironments({
        parent: `projects/${project}/locations/${CAPACITY_REGION}`,
        pageSize: 10,
      });
      expect(
        (page.environments ?? []).map((environment) => environment.name),
      ).not.toContain(
        `projects/${project}/locations/${CAPACITY_REGION}/environments/alchemy-composer-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:composer", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a composer environment",
  (stack) =>
    Effect.gen(function* () {
      const serviceAccount = yield* defaultComputeServiceAccount;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Composer.Environment("Airflow", {
            location: CAPACITY_REGION,
            labels: { env: "test" },
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              nodeConfig: { serviceAccount },
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
        }),
      );

      expect(created.name).toContain("/environments/");
      expect(created.environmentId).toEqual(expect.any(String));
      expect(created.location).toEqual(CAPACITY_REGION);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("RUNNING");

      const fetched = yield* composer.getProjectsLocationsEnvironments({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.state).toEqual("RUNNING");
      expect(fetched.config?.nodeConfig?.serviceAccount).toEqual(
        serviceAccount,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Composer.Environment("Airflow", {
            environmentId: created.environmentId,
            location: CAPACITY_REGION,
            labels: { env: "prod", role: "airflow" },
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              nodeConfig: { serviceAccount },
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "airflow" });

      const refetched = yield* composer.getProjectsLocationsEnvironments({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("airflow");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Create (~45 min) + update + delete; a timed-out lifecycle is not retried.
  {
    tags: ["provider:gcp", "provider:gcp:composer", "live"],
    timeout: 5_400_000,
    retry: 0,
  },
);
