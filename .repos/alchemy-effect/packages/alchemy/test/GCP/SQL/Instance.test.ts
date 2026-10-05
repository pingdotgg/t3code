import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<
    GCP.ProviderRequirements,
    never,
    StackServices
  >,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloud SQL instances take well over 5 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (project: string, instance: string) =>
  sqladmin.getInstances({ project, instance }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "lists sql instances and treats a missing instance as NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const page = yield* sqladmin.listInstances({
        project,
        maxResults: 10,
      });
      expect((page.items ?? []).map((instance) => instance.name)).not.toContain(
        "alchemy-sql-instance-does-not-exist",
      );

      const error = yield* Effect.flip(
        sqladmin.getInstances({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Instance("AppDb", {
            region: "us-central1",
            databaseVersion: "MYSQL_8_0",
            tier: "db-f1-micro",
            backupEnabled: false,
            deletionProtectionEnabled: false,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.instanceName).toEqual(expect.any(String));
      expect(created.region).toEqual("us-central1");
      expect(created.databaseVersion).toEqual("MYSQL_8_0");
      expect(created.tier).toEqual("db-f1-micro");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.deletionProtectionEnabled).toEqual(false);
      expect(created.state).toEqual("RUNNABLE");

      const fetched = yield* sqladmin.getInstances({
        project: created.project,
        instance: created.instanceName,
      });
      expect(fetched.name).toEqual(created.instanceName);
      expect(fetched.settings?.userLabels?.env).toEqual("test");
      expect(fetched.settings?.tier).toEqual("db-f1-micro");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Instance("AppDb", {
            instanceName: created.instanceName,
            region: "us-central1",
            databaseVersion: "MYSQL_8_0",
            tier: "db-f1-micro",
            backupEnabled: false,
            deletionProtectionEnabled: false,
            labels: { env: "prod", role: "db" },
          });
        }),
      );

      expect(updated.instanceName).toEqual(created.instanceName);
      expect(updated.labels).toMatchObject({ env: "prod", role: "db" });

      const refetched = yield* sqladmin.getInstances({
        project: created.project,
        instance: created.instanceName,
      });
      expect(refetched.settings?.userLabels?.env).toEqual("prod");
      expect(refetched.settings?.userLabels?.role).toEqual("db");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.instanceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Create 5–15 minutes, label patch, delete a few minutes.
  {
    tags: ["provider:gcp", "provider:gcp:sql", "live"],
    timeout: 2_400_000,
    retry: 0,
  },
);
