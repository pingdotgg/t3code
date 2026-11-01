import { GcpEnvironment } from "@/GCP/Environment";
import { Action } from "@/Action";
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
  alloydb.getProjectsLocationsClustersUsers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsClustersUsers on a missing user fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        alloydb.getProjectsLocationsClustersUsers({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-alloydb-missing/users/alchemy_alloydb_missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:alloydb", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an alloydb cluster user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-user-cluster",
            labels: { env: "test" },
            initialUser: { user: "postgres", password: "AlchemyTest1" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceType: "PRIMARY",
            machineConfig: { cpuCount: 2 },
          });
          const user = yield* GCP.AlloyDB.ClustersUser("AppUser", {
            cluster: instance.clusterName,
            password: "AlchemyUser1",
            databaseRoles: ["alloydbsuperuser"],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* instance.name;
              const getUser = yield* GCP.AlloyDB.GetUser(user);
              return Effect.fn(function* () {
                return yield* getUser();
              });
            }),
          );
          return { cluster, instance, user, probe: yield* Probe({}) };
        }),
      );

      expect(created.user.name).toContain("/users/");
      expect(created.user.clusterId).toEqual(created.cluster.clusterId);
      expect(created.user.location).toEqual("us-central1");
      expect(created.user.userType).toEqual("ALLOYDB_BUILT_IN");
      expect(created.user.databaseRoles).toContain("alloydbsuperuser");
      expect(created.probe.name).toEqual(created.user.name);

      const fetched = yield* alloydb.getProjectsLocationsClustersUsers({
        name: created.user.name,
      });
      expect(fetched.name).toEqual(created.user.name);
      expect(fetched.userType).toEqual("ALLOYDB_BUILT_IN");
      expect(fetched.databaseRoles ?? []).toContain("alloydbsuperuser");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-user-cluster",
            labels: { env: "test" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceId: created.instance.instanceId,
            instanceType: "PRIMARY",
            machineConfig: { cpuCount: 2 },
          });
          const user = yield* GCP.AlloyDB.ClustersUser("AppUser", {
            cluster: instance.clusterName,
            userId: created.user.userId,
            password: "AlchemyUser2",
            databaseRoles: ["alloydbsuperuser", "pg_monitor"],
          });
          return { cluster, instance, user };
        }),
      );

      expect(updated.user.name).toEqual(created.user.name);
      expect(updated.user.databaseRoles).toEqual(
        expect.arrayContaining(["alloydbsuperuser", "pg_monitor"]),
      );

      const refetched = yield* alloydb.getProjectsLocationsClustersUsers({
        name: created.user.name,
      });
      expect(refetched.databaseRoles ?? []).toEqual(
        expect.arrayContaining(["alloydbsuperuser", "pg_monitor"]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.user.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
    timeout: 3_600_000,
  },
);
