import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as osconfig from "@distilled.cloud/gcp/osconfig_v2";
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
  osconfig.getProjectsLocationsGlobalPolicyOrchestrators({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// The OS Config API is disabled on the testing project (every call fails
// with ServiceDisabled). Set GCP_TEST_OSCONFIG=1 on a project with OS Config
// enabled.
const runLifecycle = !!process.env.GCP_TEST_OSCONFIG;

test.provider(
  "getProjectsLocationsGlobalPolicyOrchestrators on a missing orchestrator fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/global`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        osconfig.getProjectsLocationsGlobalPolicyOrchestrators({
          name: `${parent}/policyOrchestrators/alchemy-missing-orch`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:osconfig", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a project policy orchestrator",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/global`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSConfig.ProjectsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              description: "validation only",
              labels: { env: "test" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(created.policyOrchestratorId).toEqual(expect.any(String));
      expect(created.parent).toEqual(parent);
      expect(created.name).toEqual(
        `${parent}/policyOrchestrators/${created.policyOrchestratorId}`,
      );
      expect(created.action).toEqual("UPSERT");
      expect(created.state).toEqual("STOPPED");
      expect(created.description).toEqual("validation only");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* osconfig.getProjectsLocationsGlobalPolicyOrchestrators({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.state).toEqual("STOPPED");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSConfig.ProjectsLocationsGlobalPolicyOrchestrator(
            "Debian",
            {
              policyOrchestratorId: created.policyOrchestratorId,
              description: "updated",
              labels: { env: "prod", role: "os" },
              state: "STOPPED",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated");
      expect(updated.labels).toMatchObject({ env: "prod", role: "os" });

      const refetched =
        yield* osconfig.getProjectsLocationsGlobalPolicyOrchestrators({
          name: created.name,
        });
      expect(refetched.description).toEqual("updated");
      expect(refetched.labels?.env).toEqual("prod");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:osconfig", "live"], timeout: 90_000 },
);
