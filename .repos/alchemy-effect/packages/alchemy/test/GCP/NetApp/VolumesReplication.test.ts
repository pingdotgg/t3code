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

// Two pools + volume + replication: skip unless explicitly enabled.
// Volumes need a Private Service Access connection to
// `netapp.servicenetworking.goog` on the `default` network (otherwise volume
// create fails with `Please create Service Networking connection with
// service 'netapp.servicenetworking.goog' ...`), and each file provisions its
// own 2 TiB STANDARD pool while the default regional quota
// (StandardStoragePoolCapacityGiBPerRegion = 2048) fits one. Set
// GCP_TEST_NETAPP_VOLUMES=1 on a project with both.
const runLifecycle = !!process.env.GCP_TEST_NETAPP_VOLUMES && !process.env.FAST;

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsVolumesReplications({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsVolumesReplications on a missing replication fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsVolumesReplications({
          name: `projects/${project}/locations/us-central1/volumes/alchemy-netapp-missing/replications/alchemy-repl-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* netapp.listProjectsLocationsVolumesReplications({
        parent: `projects/${project}/locations/us-central1/volumes/-`,
        pageSize: 10,
      });
      expect((page.replications ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/volumes/alchemy-netapp-missing/replications/alchemy-repl-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a volume replication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const sourcePool = yield* GCP.NetApp.StoragePool("Source", {
            location: "us-central1",
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const destPool = yield* GCP.NetApp.StoragePool("Dest", {
            location: "us-east4",
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const volume = yield* GCP.NetApp.Volume("Share", {
            location: "us-central1",
            storagePool: sourcePool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            shareName: "alchrepl",
            labels: { env: "test" },
          });
          const replication = yield* GCP.NetApp.VolumesReplication("Dr", {
            volume: volume.name,
            replicationSchedule: "HOURLY",
            destinationVolumeParameters: {
              storagePool: destPool.name,
              shareName: "alchrepl",
              description: "alchemy replica",
            },
            description: "alchemy-test-repl",
            labels: { env: "test" },
            deleteDestinationVolume: true,
          });
          return { sourcePool, destPool, volume, replication };
        }),
      );

      expect(created.replication.name).toContain("/replications/");
      expect(created.replication.replicationId).toEqual(expect.any(String));
      expect(created.replication.volume).toEqual(created.volume.name);
      expect(created.replication.description).toEqual("alchemy-test-repl");
      expect(created.replication.labels).toMatchObject({ env: "test" });
      expect(created.replication.replicationSchedule).toEqual("HOURLY");

      const fetched = yield* netapp.getProjectsLocationsVolumesReplications({
        name: created.replication.name,
      });
      expect(fetched.name).toEqual(created.replication.name);
      expect(fetched.description).toEqual("alchemy-test-repl");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.replicationSchedule).toEqual("HOURLY");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const sourcePool = yield* GCP.NetApp.StoragePool("Source", {
            storagePoolId: created.sourcePool.storagePoolId,
            location: "us-central1",
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const destPool = yield* GCP.NetApp.StoragePool("Dest", {
            storagePoolId: created.destPool.storagePoolId,
            location: "us-east4",
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const volume = yield* GCP.NetApp.Volume("Share", {
            volumeId: created.volume.volumeId,
            location: "us-central1",
            storagePool: sourcePool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            shareName: "alchrepl",
            labels: { env: "test" },
          });
          const replication = yield* GCP.NetApp.VolumesReplication("Dr", {
            volume: volume.name,
            replicationId: created.replication.replicationId,
            replicationSchedule: "DAILY",
            destinationVolumeParameters: {
              storagePool: destPool.name,
              shareName: "alchrepl",
            },
            description: "alchemy-prod-repl",
            labels: { env: "prod", role: "dr" },
            deleteDestinationVolume: true,
          });
          return { sourcePool, destPool, volume, replication };
        }),
      );

      expect(updated.replication.name).toEqual(created.replication.name);
      expect(updated.replication.description).toEqual("alchemy-prod-repl");
      expect(updated.replication.labels).toMatchObject({
        env: "prod",
        role: "dr",
      });
      expect(updated.replication.replicationSchedule).toEqual("DAILY");

      const refetched = yield* netapp.getProjectsLocationsVolumesReplications({
        name: created.replication.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-repl");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.replicationSchedule).toEqual("DAILY");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.replication.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 900_000 },
);
