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

// Workload Manager API is entitlement-gated on the default testing project
// (`ServiceDisabled`: "Workload Manager API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_WORKLOADMANAGER=1 on an entitled project to run the lifecycle.
const entitled = process.env.GCP_TEST_WORKLOADMANAGER === "1";
const runLifecycle = entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  workloadmanager.getProjectsLocationsEvaluations({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const firstRuleName = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const parent = parentOf(project);
  const page = yield* workloadmanager
    .listProjectsLocationsRules({
      parent,
      evaluationType: "SAP",
      pageSize: 20,
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.succeed({ rules: [] as const })),
    );
  const named = (page.rules ?? []).find(
    (rule) => typeof rule.name === "string" && rule.name.length > 0,
  );
  return named?.name ?? "sap-hana";
});

test.provider(
  "getProjectsLocationsEvaluations fails with ServiceDisabled while the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = parentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.getProjectsLocationsEvaluations({
          name: `${parent}/evaluations/alchemy-missing-evaluation`,
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
  "createProjectsLocationsEvaluations is rejected with ServiceDisabled while Workload Manager is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = parentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        workloadmanager.createProjectsLocationsEvaluations({
          parent,
          evaluationId: "alchemy-evaluation-probe",
          body: {
            evaluationType: "SAP",
            ruleNames: ["sap-hana"],
            resourceFilter: { scopes: [`projects/${project}`] },
            description: "alchemy-probe",
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
  "create, update, and delete an evaluation",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const ruleName = yield* firstRuleName;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.WorkloadManager.Evaluation("SapBest", {
            evaluationType: "SAP",
            ruleNames: [ruleName],
            resourceFilter: { scopes: [`projects/${project}`] },
            description: "alchemy-test-evaluation",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/evaluations/");
      expect(created.evaluationId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.description).toEqual("alchemy-test-evaluation");
      expect(created.ruleNames.length).toBeGreaterThan(0);

      const fetched = yield* workloadmanager.getProjectsLocationsEvaluations({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.WorkloadManager.Evaluation("SapBest", {
            evaluationId: created.evaluationId,
            evaluationType: "SAP",
            ruleNames: [ruleName],
            resourceFilter: { scopes: [`projects/${project}`] },
            description: "alchemy-test-evaluation-v2",
            labels: { env: "prod", role: "eval" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.evaluationId).toEqual(created.evaluationId);
      expect(updated.description).toEqual("alchemy-test-evaluation-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "eval" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workloadmanager", "live"],
    timeout: 120_000,
  },
);
