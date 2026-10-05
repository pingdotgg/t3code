import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
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

// Cluster create + update + delete takes ~8 minutes (observed 475s).
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (
  projectId: string,
  region: string,
  clusterName: string,
) =>
  dataproc.getProjectsRegionsClusters({ projectId, region, clusterName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsRegionsClusters on a missing cluster fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataproc.getProjectsRegionsClusters({
          projectId: project,
          region: "us-central1",
          clusterName: "alchemy-dataproc-missing",
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:dataproc", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a dataproc cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.Cluster("Spark", {
            region: "us-central1",
            clusterType: "SINGLE_NODE",
            masterMachineType: "e2-standard-2",
            masterBootDiskSizeGb: 30,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/clusters/");
      expect(created.clusterName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.clusterType).toEqual("SINGLE_NODE");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.state).toEqual("RUNNING");

      const fetched = yield* dataproc.getProjectsRegionsClusters({
        projectId: created.project,
        region: created.region,
        clusterName: created.clusterName,
      });
      expect(fetched.clusterName).toEqual(created.clusterName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.status?.state).toEqual("RUNNING");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataproc.Cluster("Spark", {
            clusterName: created.clusterName,
            region: "us-central1",
            clusterType: "SINGLE_NODE",
            masterMachineType: "e2-standard-2",
            masterBootDiskSizeGb: 30,
            labels: { env: "prod", role: "spark" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "spark" });

      const refetched = yield* dataproc.getProjectsRegionsClusters({
        projectId: created.project,
        region: created.region,
        clusterName: created.clusterName,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("spark");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.region,
        created.clusterName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:dataproc", "live"],
    timeout: 1_800_000,
  },
);
