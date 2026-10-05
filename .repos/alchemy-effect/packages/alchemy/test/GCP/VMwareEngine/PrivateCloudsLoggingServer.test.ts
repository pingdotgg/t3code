import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
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

// Private clouds need VMware Engine node quota and bill thousands of dollars
// a month; set GCP_TEST_VMWAREENGINE=1 on an entitled project to opt in.
const runLifecycle = !!process.env.GCP_TEST_VMWAREENGINE && !process.env.FAST;

const waitUntilGone = (name: string) =>
  vmwareengine.getProjectsLocationsPrivateCloudsLoggingServers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsPrivateCloudsLoggingServers on a missing logging server fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsPrivateCloudsLoggingServers({
          name: `projects/${project}/locations/us-central1-a/privateClouds/alchemy-missing/loggingServers/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a logging server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            type: "STANDARD",
            description: "syslog grandparent",
          });
          const cloud = yield* GCP.VMwareEngine.PrivateCloud("Sddc", {
            location: "us-central1-a",
            networkConfig: {
              managementCidr: "192.168.1.0/24",
              vmwareEngineNetwork: ven.name,
            },
            managementCluster: {
              clusterId: "mgmt",
              nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
            },
            description: "syslog parent",
          });
          const syslog = yield* GCP.VMwareEngine.PrivateCloudsLoggingServer(
            "Esxi",
            {
              privateCloud: cloud.name,
              hostname: "logs.example.com",
              port: 514,
              protocol: "UDP",
              sourceType: "ESXI",
            },
          );
          return { ven, cloud, syslog };
        }),
      );

      expect(created.syslog.name).toContain("/loggingServers/");
      expect(created.syslog.hostname).toEqual("logs.example.com");
      expect(created.syslog.port).toEqual(514);
      expect(created.syslog.protocol).toEqual("UDP");
      expect(created.syslog.sourceType).toEqual("ESXI");

      const fetched =
        yield* vmwareengine.getProjectsLocationsPrivateCloudsLoggingServers({
          name: created.syslog.name,
        });
      expect(fetched.name).toEqual(created.syslog.name);
      expect(fetched.hostname).toEqual("logs.example.com");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const ven = yield* GCP.VMwareEngine.VmwareEngineNetwork("Ven", {
            vmwareEngineNetworkId: created.ven.vmwareEngineNetworkId,
            type: "STANDARD",
            description: "syslog grandparent",
          });
          const cloud = yield* GCP.VMwareEngine.PrivateCloud("Sddc", {
            privateCloudId: created.cloud.privateCloudId,
            location: "us-central1-a",
            networkConfig: {
              managementCidr: "192.168.1.0/24",
              vmwareEngineNetwork: ven.name,
            },
            managementCluster: {
              clusterId: "mgmt",
              nodeTypeConfigs: { "standard-72": { nodeCount: 3 } },
            },
            description: "syslog parent",
          });
          const syslog = yield* GCP.VMwareEngine.PrivateCloudsLoggingServer(
            "Esxi",
            {
              privateCloud: cloud.name,
              loggingServerId: created.syslog.loggingServerId,
              hostname: "logs.example.com",
              port: 6514,
              protocol: "TCP",
              sourceType: "VCSA",
            },
          );
          return { ven, cloud, syslog };
        }),
      );

      expect(updated.syslog.name).toEqual(created.syslog.name);
      expect(updated.syslog.port).toEqual(6514);
      expect(updated.syslog.protocol).toEqual("TCP");
      expect(updated.syslog.sourceType).toEqual("VCSA");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.syslog.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 120_000,
  },
);
