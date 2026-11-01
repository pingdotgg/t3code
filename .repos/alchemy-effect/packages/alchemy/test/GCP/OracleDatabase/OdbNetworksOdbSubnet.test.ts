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
const location = "us-central1";

const waitUntilGone = (name: string) =>
  oracle.getProjectsLocationsOdbNetworksOdbSubnets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsOdbNetworksOdbSubnets without Oracle Database enabled fails with ServiceDisabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsOdbNetworksOdbSubnets({
          name: `projects/${project}/locations/${location}/odbNetworks/alchemy-odb-missing/odbSubnets/alchemy-subnet-missing`,
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
  "create, update, and delete an odb subnet",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const net = yield* GCP.OracleDatabase.OdbNetwork("OracleNet", {
            location,
            network: "default",
            labels: { env: "test" },
          });
          const subnet = yield* GCP.OracleDatabase.OdbNetworksOdbSubnet(
            "Client",
            {
              odbNetwork: net.name,
              location,
              cidrRange: "10.250.0.0/27",
              purpose: "CLIENT_SUBNET",
              labels: { env: "test" },
            },
          );
          return { net, subnet };
        }),
      );

      expect(created.subnet.name).toContain("/odbSubnets/");
      expect(created.subnet.odbSubnetId).toEqual(expect.any(String));
      expect(created.subnet.odbNetwork).toEqual(created.net.name);
      expect(created.subnet.cidrRange).toEqual("10.250.0.0/27");
      expect(created.subnet.purpose).toEqual("CLIENT_SUBNET");
      expect(created.subnet.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsOdbNetworksOdbSubnets({
        name: created.subnet.name,
      });
      expect(fetched.name).toEqual(created.subnet.name);
      expect(fetched.cidrRange).toEqual("10.250.0.0/27");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const net = yield* GCP.OracleDatabase.OdbNetwork("OracleNet", {
            odbNetworkId: created.net.odbNetworkId,
            location,
            network: "default",
            labels: { env: "prod" },
          });
          const subnet = yield* GCP.OracleDatabase.OdbNetworksOdbSubnet(
            "Client",
            {
              odbNetwork: net.name,
              odbSubnetId: created.subnet.odbSubnetId,
              location,
              cidrRange: "10.250.0.0/27",
              purpose: "CLIENT_SUBNET",
              labels: { env: "prod", role: "client" },
            },
          );
          return { net, subnet };
        }),
      );

      expect(updated.subnet.name).toEqual(created.subnet.name);
      expect(updated.subnet.odbSubnetId).toEqual(created.subnet.odbSubnetId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subnet.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
    timeout: 120_000,
  },
);
