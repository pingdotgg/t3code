import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as workloadmanager from "@distilled.cloud/gcp/workloadmanager_v1";
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

const parentOf = (project: string) =>
  `projects/${project}/locations/us-central1`;
const missingDeploymentOf = (project: string) =>
  `${parentOf(project)}/deployments/alchemy-missing-deployment`;

// Workload Manager API is entitlement-gated on the default testing project
// (`ServiceDisabled`: "Workload Manager API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_WORKLOADMANAGER=1 on an entitled project to run the lifecycle.
const entitled = process.env.GCP_TEST_WORKLOADMANAGER === "1";
const runLifecycle = entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  workloadmanager.getProjectsLocationsDeploymentsActuations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDeploymentsActuations on a missing actuation fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingDeployment = missingDeploymentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.getProjectsLocationsDeploymentsActuations({
          name: `${missingDeployment}/actuations/alchemy-missing-actuation`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(entitled)(
  "createProjectsLocationsDeploymentsActuations is rejected with ServiceDisabled while Workload Manager is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingDeployment = missingDeploymentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.createProjectsLocationsDeploymentsActuations({
          parent: missingDeployment,
          body: {
            name: `${missingDeployment}/actuations/alchemy-actuation-probe`,
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create against a missing deployment is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingDeployment = missingDeploymentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.WorkloadManager.DeploymentsActuation(
              "Bootstrap",
              {
                deployment: missingDeployment,
              },
            );
          }),
        ),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(
  !runLifecycle || !process.env.GCP_TEST_WORKLOADMANAGER_DEPLOYMENT,
)(
  "create and delete an actuation under an entitled deployment",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const deploymentName = process.env.GCP_TEST_WORKLOADMANAGER_DEPLOYMENT;
      expect(deploymentName).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.WorkloadManager.DeploymentsActuation("Bootstrap", {
            deployment: deploymentName!,
          });
        }),
      );

      expect(created.name).toContain("/actuations/");
      expect(created.actuationId).toEqual(expect.any(String));
      expect(created.deployment).toEqual(deploymentName);
      expect(created.project).toEqual(project);

      const fetched =
        yield* workloadmanager.getProjectsLocationsDeploymentsActuations({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 120_000,
  },
);
