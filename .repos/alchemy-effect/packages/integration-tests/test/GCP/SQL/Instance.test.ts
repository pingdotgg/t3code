import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { DestroyError } from "alchemy/Apply";
import type { StackServices } from "alchemy/Stack";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<GCP.ProviderRequirements, never, StackServices>,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
            backup: { enabled: false },
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
            backup: { enabled: false },
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

test.provider.skipIf(!runLifecycle)(
  "upgrades databaseVersion in place within the same engine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Instance("UpgradeDb", {
            region: "us-central1",
            databaseVersion: "POSTGRES_16",
            tier: "db-f1-micro",
            backup: { enabled: false },
            deletionProtectionEnabled: false,
          });
        }),
      );
      expect(created.databaseVersion).toEqual("POSTGRES_16");

      const upgraded = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Instance("UpgradeDb", {
            region: "us-central1",
            databaseVersion: "POSTGRES_17",
            tier: "db-f1-micro",
            backup: { enabled: false },
            deletionProtectionEnabled: false,
          });
        }),
      );

      // Same physical instance: upgraded, not replaced.
      expect(upgraded.instanceName).toEqual(created.instanceName);
      expect(upgraded.createTime).toEqual(created.createTime);
      expect(upgraded.databaseVersion).toEqual("POSTGRES_17");

      const fetched = yield* sqladmin.getInstances({
        project: created.project,
        instance: created.instanceName,
      });
      expect(fetched.databaseVersion).toEqual("POSTGRES_17");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.instanceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Create 5–15 minutes, major version upgrade 33–54 minutes, delete a few minutes.
  {
    tags: ["provider:gcp", "provider:gcp:sql", "live"],
    timeout: 7_200_000,
    retry: 0,
  },
);

test.provider.skipIf(!runLifecycle)(
  "destroy fails on a deletion-protected instance until protection is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Instance("ProtectedDb", {
            region: "us-central1",
            databaseVersion: "MYSQL_8_0",
            tier: "db-f1-micro",
            backup: { enabled: false },
            deletionProtectionEnabled: true,
          });
        }),
      );
      expect(created.deletionProtectionEnabled).toEqual(true);

      const error = yield* Effect.flip(stack.destroy());
      expect(error).toBeInstanceOf(DestroyError);
      const failures = error instanceof DestroyError ? error.failures : [];
      expect(failures.map((failure) => failure.resourceType)).toEqual(["GCP.SQL.Instance"]);
      expect(failures[0]?.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(
        GCP.SQL.InstanceDeletionProtected,
      );

      const stillThere = yield* sqladmin.getInstances({
        project: created.project,
        instance: created.instanceName,
      });
      expect(stillThere.settings?.deletionProtectionEnabled).toEqual(true);

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.Instance("ProtectedDb", {
            region: "us-central1",
            databaseVersion: "MYSQL_8_0",
            tier: "db-f1-micro",
            backup: { enabled: false },
            deletionProtectionEnabled: false,
          });
        }),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.instanceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // Create 5–15 minutes, protection patch, delete a few minutes.
  {
    tags: ["provider:gcp", "provider:gcp:sql", "live"],
    timeout: 2_400_000,
    retry: 0,
  },
);

test.provider.skipIf(!!process.env.FAST)(
  "private ip, ssl mode, backup retention, and storage auto-resize converge in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const privateDb = (settings: {
        sslMode: string;
        retainedBackups: number;
        transactionLogRetentionDays: number;
        storageAutoResize: boolean;
      }) =>
        Effect.gen(function* () {
          const network = yield* GCP.Compute.Network("SqlVpc", {
            autoCreateSubnetworks: false,
          });
          const range = yield* GCP.Compute.GlobalAddress("SqlPsaRange", {
            addressType: "INTERNAL",
            purpose: "VPC_PEERING",
            network: network.selfLink,
            prefixLength: 24,
          });
          const psa = yield* GCP.ServiceNetworking.Connection("SqlPsa", {
            network: network.networkName,
            reservedPeeringRanges: [range.addressName],
          });
          const db = yield* GCP.SQL.Instance("PrivateDb", {
            region: "us-central1",
            databaseVersion: "POSTGRES_17",
            tier: "db-f1-micro",
            deletionProtectionEnabled: false,
            ipConfiguration: {
              ipv4Enabled: false,
              privateNetwork: psa.network,
              allocatedIpRange: range.addressName,
              sslMode: settings.sslMode,
            },
            backup: {
              enabled: true,
              retainedBackups: settings.retainedBackups,
              transactionLogRetentionDays: settings.transactionLogRetentionDays,
            },
            storageAutoResize: settings.storageAutoResize,
          });
          return { network, range, db };
        });

      const created = yield* stack.deploy(
        privateDb({
          sslMode: "ENCRYPTED_ONLY",
          retainedBackups: 7,
          transactionLogRetentionDays: 3,
          storageAutoResize: true,
        }),
      );

      expect(created.db.ipv4Enabled).toEqual(false);
      expect(created.db.ipAddress).toBeUndefined();
      expect(created.db.privateIpAddress).toEqual(expect.any(String));
      expect(created.db.sslMode).toEqual("ENCRYPTED_ONLY");
      expect(created.db.backupEnabled).toEqual(true);
      expect(created.db.retainedBackups).toEqual(7);
      expect(created.db.transactionLogRetentionDays).toEqual(3);
      expect(created.db.storageAutoResize).toEqual(true);

      const fetched = yield* sqladmin.getInstances({
        project: created.db.project,
        instance: created.db.instanceName,
      });
      expect((fetched.ipAddresses ?? []).map((address) => address.type)).toEqual(["PRIVATE"]);
      expect(fetched.settings?.ipConfiguration?.ipv4Enabled).toEqual(false);
      expect(fetched.settings?.ipConfiguration?.privateNetwork?.split("/").pop()).toEqual(
        created.network.networkName,
      );
      expect(fetched.settings?.ipConfiguration?.allocatedIpRange).toEqual(
        created.range.addressName,
      );
      expect(fetched.settings?.ipConfiguration?.sslMode).toEqual("ENCRYPTED_ONLY");
      expect(fetched.settings?.backupConfiguration?.enabled).toEqual(true);
      expect(fetched.settings?.backupConfiguration?.pointInTimeRecoveryEnabled).toEqual(true);
      expect(
        fetched.settings?.backupConfiguration?.backupRetentionSettings?.retainedBackups,
      ).toEqual(7);
      expect(fetched.settings?.backupConfiguration?.transactionLogRetentionDays).toEqual(3);
      expect(fetched.settings?.storageAutoResize).toEqual(true);

      // Redeploying identical props observes no drift and patches nothing.
      const redeployed = yield* stack.deploy(
        privateDb({
          sslMode: "ENCRYPTED_ONLY",
          retainedBackups: 7,
          transactionLogRetentionDays: 3,
          storageAutoResize: true,
        }),
      );
      const unchanged = yield* sqladmin.getInstances({
        project: created.db.project,
        instance: created.db.instanceName,
      });
      expect(redeployed.db.instanceName).toEqual(created.db.instanceName);
      expect(unchanged.settings?.settingsVersion).toEqual(fetched.settings?.settingsVersion);

      const updated = yield* stack.deploy(
        privateDb({
          sslMode: "TRUSTED_CLIENT_CERTIFICATE_REQUIRED",
          retainedBackups: 14,
          transactionLogRetentionDays: 7,
          storageAutoResize: false,
        }),
      );

      // Same physical instance: patched, not replaced.
      expect(updated.db.instanceName).toEqual(created.db.instanceName);
      expect(updated.db.createTime).toEqual(created.db.createTime);
      expect(updated.db.sslMode).toEqual("TRUSTED_CLIENT_CERTIFICATE_REQUIRED");
      expect(updated.db.retainedBackups).toEqual(14);
      expect(updated.db.transactionLogRetentionDays).toEqual(7);
      expect(updated.db.storageAutoResize).toEqual(false);

      const refetched = yield* sqladmin.getInstances({
        project: created.db.project,
        instance: created.db.instanceName,
      });
      expect(refetched.settings?.ipConfiguration?.sslMode).toEqual(
        "TRUSTED_CLIENT_CERTIFICATE_REQUIRED",
      );
      expect(refetched.settings?.ipConfiguration?.requireSsl).toEqual(true);
      expect(refetched.settings?.ipConfiguration?.ipv4Enabled).toEqual(false);
      expect(refetched.settings?.ipConfiguration?.privateNetwork?.split("/").pop()).toEqual(
        created.network.networkName,
      );
      expect(
        refetched.settings?.backupConfiguration?.backupRetentionSettings?.retainedBackups,
      ).toEqual(14);
      expect(refetched.settings?.backupConfiguration?.transactionLogRetentionDays).toEqual(7);
      expect(refetched.settings?.storageAutoResize).toEqual(false);
      expect(refetched.settings?.tier).toEqual("db-f1-micro");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.db.project, created.db.instanceName);
      expect(gone).toEqual("gone");
    }).pipe(withNetworkSlot, logLevel),
  // Create 5–15 minutes, settings patch a few minutes, delete a few minutes.
  {
    tags: ["provider:gcp", "provider:gcp:sql", "live"],
    timeout: 2_400_000,
    retry: 0,
  },
);
