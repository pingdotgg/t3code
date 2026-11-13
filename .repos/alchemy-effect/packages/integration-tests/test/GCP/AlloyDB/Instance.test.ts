import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// AlloyDB clusters and instances take well over 5 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  alloydb.getProjectsLocationsClustersInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsClustersInstances on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        alloydb.getProjectsLocationsClustersInstances({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-alloydb-missing/instances/alchemy-alloydb-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* alloydb.listProjectsLocationsClustersInstances({
        parent: `projects/${project}/locations/-/clusters/-`,
        pageSize: 10,
      });
      expect((page.instances ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/clusters/alchemy-alloydb-missing/instances/alchemy-alloydb-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:alloydb", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an alloydb instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-instance-cluster",
            labels: { env: "test" },
            initialUser: { user: "postgres", password: "AlchemyTest1" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceType: "PRIMARY",
            displayName: "alchemy-test-primary",
            labels: { env: "test" },
            machineConfig: { cpuCount: 2 },
          });
          return { cluster, instance };
        }),
      );

      expect(created.instance.name).toContain("/instances/");
      expect(created.instance.clusterId).toEqual(created.cluster.clusterId);
      expect(created.instance.location).toEqual("us-central1");
      expect(created.instance.instanceType).toEqual("PRIMARY");
      expect(created.instance.displayName).toEqual("alchemy-test-primary");
      expect(created.instance.labels).toMatchObject({ env: "test" });
      expect(created.instance.machineConfig?.cpuCount).toEqual(2);
      expect(["READY", "STOPPED"]).toContain(created.instance.state);

      const fetched = yield* alloydb.getProjectsLocationsClustersInstances({
        name: created.instance.name,
      });
      expect(fetched.name).toEqual(created.instance.name);
      expect(fetched.instanceType).toEqual("PRIMARY");
      // GCP omits displayName from instance reads; the attributes carry it.
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.machineConfig?.cpuCount).toEqual(2);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-instance-cluster",
            labels: { env: "test" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceId: created.instance.instanceId,
            instanceType: "PRIMARY",
            displayName: "alchemy-prod-primary",
            labels: { env: "prod", role: "primary" },
            machineConfig: { cpuCount: 2 },
          });
          return { cluster, instance };
        }),
      );

      expect(updated.instance.name).toEqual(created.instance.name);
      expect(updated.instance.displayName).toEqual("alchemy-prod-primary");
      expect(updated.instance.labels).toMatchObject({
        env: "prod",
        role: "primary",
      });

      const refetched = yield* alloydb.getProjectsLocationsClustersInstances({
        name: created.instance.name,
      });
      // GCP omits displayName from instance reads; the attributes carry it.
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("primary");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.instance.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
    timeout: 3_600_000,
  },
);

const MIGRATIONS_PASSWORD = "AlchemyTest1";

/** Applied migration names, read out-of-band through the Data API. */
const appliedMigrations = (instance: string) =>
  alloydb
    .executeSqlProjectsLocationsClustersInstances({
      instance,
      body: {
        database: "postgres",
        user: "postgres",
        password: MIGRATIONS_PASSWORD,
        sqlStatement: "SELECT name FROM __alchemy_migrations ORDER BY id",
      },
    })
    .pipe(
      Effect.map((response) => {
        expect(response.metadata?.status).not.toEqual("ERROR");
        return (response.sqlResults?.[0]?.rows ?? []).map((row) => row.values?.[0]?.value);
      }),
    );

test.provider.skipIf(!!process.env.FAST)(
  "a primary applies migrations over the Data API, then only pending ones",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-alloydb-migrations-" });
      const add = (name: string, sql: string) => fs.writeFileString(path.join(dir, name), sql);
      yield* add("0001_users.sql", "CREATE TABLE users (id INT PRIMARY KEY, name TEXT NOT NULL);");

      const program = Effect.gen(function* () {
        const cluster = yield* GCP.AlloyDB.Cluster("MigrationsDb", {
          location: "us-central1",
          pscConfig: { pscEnabled: true },
          initialUser: { user: "postgres", password: MIGRATIONS_PASSWORD },
          automatedBackupPolicy: { enabled: false },
          continuousBackupConfig: { enabled: false },
        });
        return yield* GCP.AlloyDB.Instance("Primary", {
          cluster: cluster.name,
          instanceType: "PRIMARY",
          machineConfig: { cpuCount: 2 },
          dataApiAccess: "ENABLED",
          migrations: dir,
          migrationsUser: "postgres",
          migrationsPassword: MIGRATIONS_PASSWORD,
        });
      });

      yield* stack.destroy();

      const created = yield* stack.deploy(program);
      expect(created.migrationsTable).toEqual("__alchemy_migrations");
      expect(Object.keys(created.migrationsHashes)).toEqual(["0001_users.sql"]);
      expect(yield* appliedMigrations(created.name)).toEqual(["0001_users.sql"]);

      // Nothing changed: the next deploy has nothing to apply.
      const unchanged = yield* stack.plan(program);
      expect(unchanged.resources.Primary?.action).toEqual("noop");

      yield* add("0002_posts.sql", "CREATE TABLE posts (id INT PRIMARY KEY, title TEXT NOT NULL);");
      const pending = yield* stack.plan(program);
      expect(pending.resources.Primary?.action).toEqual("update");

      const updated = yield* stack.deploy(program);
      expect(updated.name).toEqual(created.name);
      expect(Object.keys(updated.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);
      expect(yield* appliedMigrations(updated.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.name)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
    timeout: 3_600_000,
  },
);
