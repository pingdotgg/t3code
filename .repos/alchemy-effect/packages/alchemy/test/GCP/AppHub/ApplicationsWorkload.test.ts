import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apphub from "@distilled.cloud/gcp/apphub_v1";
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

// App Hub is not enabled in the test project; live calls fail with
// ServiceDisabled:
// "App Hub API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled." Workload registration also needs a
// discovered workload in the host project.
const runLifecycle = !process.env.FAST && process.env.GCP_TEST_APPHUB === "1";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apphub.getProjectsLocationsApplicationsWorkloads({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const firstDiscoveredWorkload = GcpEnvironment.current.pipe(
  Effect.flatMap(({ project }) =>
    apphub
      .listProjectsLocationsDiscoveredWorkloads({
        parent: `projects/${project}/locations/${location}`,
        pageSize: 10,
      })
      .pipe(
        Effect.map((page) => page.discoveredWorkloads?.[0]?.name),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      ),
  ),
);

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsApplicationsWorkloads on a missing workload fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apphub.getProjectsLocationsApplicationsWorkloads({
          name: `projects/${project}/locations/${location}/applications/alchemy-missing-app/workloads/alchemy-missing-workload`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apphub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an App Hub workload",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const discoveredWorkload = yield* firstDiscoveredWorkload;
      expect(discoveredWorkload).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.AppHub.Application("Store", {
            location,
            displayName: "store",
            scope: { type: "REGIONAL" },
          });
          const workload = yield* GCP.AppHub.ApplicationsWorkload("Api", {
            application: app.name,
            location,
            discoveredWorkload: discoveredWorkload!,
            displayName: "api",
            description: "checkout mig",
            attributes: { criticality: { type: "MEDIUM" } },
          });
          return { app, workload };
        }),
      );

      expect(created.workload.name).toContain("/workloads/");
      expect(created.workload.application).toEqual(created.app.name);
      expect(created.workload.displayName).toEqual("api");
      expect(created.workload.description).toEqual("checkout mig");
      expect(created.workload.discoveredWorkload).toBeDefined();

      const fetched = yield* apphub.getProjectsLocationsApplicationsWorkloads({
        name: created.workload.name,
      });
      expect(fetched.name).toEqual(created.workload.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("checkout mig");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.AppHub.Application("Store", {
            applicationId: created.app.applicationId,
            location,
            displayName: "store",
            scope: { type: "REGIONAL" },
          });
          const workload = yield* GCP.AppHub.ApplicationsWorkload("Api", {
            workloadId: created.workload.workloadId,
            application: app.name,
            location,
            discoveredWorkload: created.workload.discoveredWorkload!,
            displayName: "api-v2",
            description: "checkout mig v2",
            attributes: { criticality: { type: "HIGH" } },
          });
          return { app, workload };
        }),
      );

      expect(updated.workload.name).toEqual(created.workload.name);
      expect(updated.workload.displayName).toEqual("api-v2");
      expect(updated.workload.description).toEqual("checkout mig v2");
      expect(updated.workload.attributes?.criticality?.type).toEqual("HIGH");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.workload.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apphub", "live"], timeout: 90_000 },
);
