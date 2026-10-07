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
  oracle.getProjectsLocationsGoldengateDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsGoldengateDeployments without Oracle Database enabled fails with ServiceDisabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsGoldengateDeployments({
          name: `projects/${project}/locations/${location}/goldengateDeployments/alchemy-gg-missing`,
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
  "create, update, and delete a goldengate deployment",
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
            },
          );
          const gg = yield* GCP.OracleDatabase.GoldengateDeployment(
            "Replicat",
            {
              location,
              odbNetwork: net.name,
              odbSubnet: subnet.name,
              displayName: "alchemy-gg",
              deploymentType: "DATABASE_ORACLE",
              oggData: {
                adminUsername: "oggadmin",
                deployment: "oggdeploy",
                adminPassword: "AlchemyTest1!",
              },
              labels: { env: "test" },
            },
          );
          return { net, subnet, gg };
        }),
      );

      expect(created.gg.name).toContain("/goldengateDeployments/");
      expect(created.gg.goldengateDeploymentId).toEqual(expect.any(String));
      expect(created.gg.location).toEqual(location);
      expect(created.gg.odbSubnet).toEqual(created.subnet.name);
      expect(created.gg.displayName).toEqual("alchemy-gg");
      expect(created.gg.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsGoldengateDeployments({
        name: created.gg.name,
      });
      expect(fetched.name).toEqual(created.gg.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.displayName).toEqual("alchemy-gg");

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
            },
          );
          const gg = yield* GCP.OracleDatabase.GoldengateDeployment(
            "Replicat",
            {
              goldengateDeploymentId: created.gg.goldengateDeploymentId,
              location,
              odbNetwork: net.name,
              odbSubnet: subnet.name,
              displayName: "alchemy-gg",
              deploymentType: "DATABASE_ORACLE",
              oggData: {
                adminUsername: "oggadmin",
                deployment: "oggdeploy",
                adminPassword: "AlchemyTest1!",
              },
              labels: { env: "prod", role: "gg" },
            },
          );
          return { net, subnet, gg };
        }),
      );

      expect(updated.gg.name).toEqual(created.gg.name);
      expect(updated.gg.goldengateDeploymentId).toEqual(
        created.gg.goldengateDeploymentId,
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.gg.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:oracledatabase", "live"],
    timeout: 120_000,
  },
);
