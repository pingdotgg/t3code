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

const missingParentOf = (project: string) =>
  `projects/${project}/locations/${CAPACITY_REGION}/environments/alchemy-composer-missing`;

const waitUntilGone = (name: string) =>
  composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsEnvironmentsUserWorkloadsSecrets on a missing secret fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingParent = missingParentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          name: `${missingParent}/userWorkloadsSecrets/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const created = yield* Effect.flip(
        composer.createProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          parent: missingParent,
          body: {
            name: `${missingParent}/userWorkloadsSecrets/alchemy-missing`,
            data: { password: btoa("s3cret") },
          },
        }),
      );
      expect(created._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:composer", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a user workloads secret",
  (stack) =>
    Effect.gen(function* () {
      const serviceAccount = yield* defaultComputeServiceAccount;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const airflow = yield* GCP.Composer.Environment("Airflow", {
            location: CAPACITY_REGION,
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              nodeConfig: { serviceAccount },
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
          const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
            "TaskSecret",
            {
              environmentName: airflow.name,
              data: { password: btoa("s3cret") },
            },
          );
          return { airflow, secret };
        }),
      );

      expect(created.secret.name).toContain("/userWorkloadsSecrets/");
      expect(created.secret.environmentName).toEqual(created.airflow.name);
      expect(created.secret.data["alchemy-id"]).toBeUndefined();

      const fetched =
        yield* composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          name: created.secret.name,
        });
      expect(fetched.name).toEqual(created.secret.name);
      expect(Object.keys(fetched.data ?? {}).sort()).toEqual(["password"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const airflow = yield* GCP.Composer.Environment("Airflow", {
            environmentId: created.airflow.environmentId,
            location: CAPACITY_REGION,
            config: {
              environmentSize: "ENVIRONMENT_SIZE_SMALL",
              nodeConfig: { serviceAccount },
              softwareConfig: { imageVersion: "composer-3-airflow-2" },
            },
          });
          const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
            "TaskSecret",
            {
              environmentName: airflow.name,
              secretId: created.secret.secretId,
              data: { password: btoa("rotated"), token: btoa("abc123") },
            },
          );
          return { airflow, secret };
        }),
      );

      expect(updated.secret.name).toEqual(created.secret.name);

      const refetched =
        yield* composer.getProjectsLocationsEnvironmentsUserWorkloadsSecrets({
          name: created.secret.name,
        });
      expect(Object.keys(refetched.data ?? {}).sort()).toEqual([
        "password",
        "token",
      ]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.secret.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Create (~45 min) + update + delete; a timed-out lifecycle is not retried.
  {
    tags: ["provider:gcp", "provider:gcp:composer", "live"],
    timeout: 5_400_000,
    retry: 0,
  },
);
