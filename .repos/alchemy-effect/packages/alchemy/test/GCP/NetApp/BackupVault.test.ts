import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
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
  netapp.getProjectsLocationsBackupVaults({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBackupVaults on a missing vault fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsBackupVaults({
          name: `projects/${project}/locations/us-central1/backupVaults/alchemy-netapp-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* netapp.listProjectsLocationsBackupVaults({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.backupVaults ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/backupVaults/alchemy-netapp-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider(
  "create, update, and delete a backup vault",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.BackupVault("Vault", {
            description: "alchemy-test-vault",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/backupVaults/");
      expect(created.backupVaultId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("alchemy-test-vault");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsBackupVaults({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("alchemy-test-vault");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetApp.BackupVault("Vault", {
            backupVaultId: created.backupVaultId,
            description: "alchemy-prod-vault",
            labels: { env: "prod", role: "backup" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-vault");
      expect(updated.labels).toMatchObject({ env: "prod", role: "backup" });

      const refetched = yield* netapp.getProjectsLocationsBackupVaults({
        name: created.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-vault");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 120_000 },
);
