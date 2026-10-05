import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
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

// Oracle Database@Google Cloud is not enabled in the test project
// (ServiceDisabled) and needs an Oracle Cloud subscription. Set
// GCP_TEST_ORACLE=1 in a project that has one.
const runLifecycle = !!process.env.GCP_TEST_ORACLE && !process.env.FAST;

const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl alchemy-test";

const waitUntilGone = (name: string) =>
  oracle.getProjectsLocationsExadbVmClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsExadbVmClusters without Oracle Database enabled fails with ServiceDisabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsExadbVmClusters({
          name: `projects/${project}/locations/us-central1/exadbVmClusters/alchemy-oracle-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an exadb vm cluster",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* GCP.OracleDatabase.ExascaleDbStorageVault(
            "Vault",
            {
              displayName: "alchemyvault",
              totalSizeGbs: 300,
            },
          );
          return yield* GCP.OracleDatabase.ExadbVmCluster("ExaVm", {
            location: "us-central1",
            displayName: "alchemyexavm",
            odbSubnet: `projects/${project}/locations/us-central1/odbNetworks/missing/odbSubnets/client`,
            backupOdbSubnet: `projects/${project}/locations/us-central1/odbNetworks/missing/odbSubnets/backup`,
            gridImageId: "19.0.0.0",
            hostnamePrefix: "exavm",
            sshPublicKeys: [SSH_KEY],
            exascaleDbStorageVault: vault.name,
            enabledEcpuCountPerNode: 8,
            nodeCount: 2,
            properties: {
              vmFileSystemStorage: { sizeInGbsPerNode: 180 },
              shapeAttribute: "SMART_STORAGE",
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/exadbVmClusters/");
      expect(created.exadbVmClusterId).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsExadbVmClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
    timeout: 120_000,
  },
);
