import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// AlloyDB clusters and instances take well over 5 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  alloydb.getProjectsLocationsClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        alloydb.getProjectsLocationsClusters({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-alloydb-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* alloydb.listProjectsLocationsClusters({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.clusters ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/clusters/alchemy-alloydb-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:alloydb", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an alloydb cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AlloyDB.Cluster("AppDb", {
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-cluster",
            labels: { env: "test" },
            initialUser: { user: "postgres", password: "AlchemyTest1" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
        }),
      );

      expect(created.name).toContain("/clusters/");
      expect(created.clusterId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("alchemy-test-cluster");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.pscConfig?.pscEnabled).toEqual(true);
      expect(["READY", "EMPTY"]).toContain(created.state);

      const fetched = yield* alloydb.getProjectsLocationsClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      // GCP omits displayName from cluster reads, so only the resource
      // attributes (asserted above) carry it.
      expect(fetched.pscConfig?.pscEnabled).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.AlloyDB.Cluster("AppDb", {
            clusterId: created.clusterId,
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-prod-cluster",
            labels: { env: "prod", role: "db" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-prod-cluster");
      expect(updated.labels).toMatchObject({ env: "prod", role: "db" });

      const refetched = yield* alloydb.getProjectsLocationsClusters({
        name: created.name,
      });
      // GCP omits displayName from cluster reads, so only the resource
      // attributes (asserted above) carry it.
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("db");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
    timeout: 3_600_000,
    retry: 0,
  },
);
