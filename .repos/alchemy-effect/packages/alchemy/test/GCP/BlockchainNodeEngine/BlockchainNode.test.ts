import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bne from "@distilled.cloud/gcp/blockchainnodeengine_v1";
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

// Blockchain nodes bill hourly and take 15-45 minutes to provision, so the
// lifecycle is opt-in: set GCP_TEST_BLOCKCHAIN_NODE=1 together with
// GCP_TEST_SLOW.
const runLifecycle =
  !!process.env.GCP_TEST_BLOCKCHAIN_NODE &&
  !!process.env.GCP_TEST_SLOW &&
  !process.env.FAST;

const waitUntilGone = (name: string) =>
  bne.getProjectsLocationsBlockchainNodes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBlockchainNodes on a missing node fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bne.getProjectsLocationsBlockchainNodes({
          name: `${parent}/blockchainNodes/alchemy-bne-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:blockchainnodeengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a blockchain node",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BlockchainNodeEngine.BlockchainNode("Sepolia", {
            location: "us-central1",
            blockchainType: "ETHEREUM",
            ethereumDetails: {
              network: "TESTNET_SEPOLIA",
              nodeType: "FULL",
              executionClient: "GETH",
              consensusClient: "LIGHTHOUSE",
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/blockchainNodes/");
      expect(created.blockchainNodeId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.project).toEqual(project);
      expect(created.blockchainType).toEqual("ETHEREUM");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.ethereumDetails?.network).toEqual("TESTNET_SEPOLIA");

      const fetched = yield* bne.getProjectsLocationsBlockchainNodes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.ethereumDetails?.network).toEqual("TESTNET_SEPOLIA");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BlockchainNodeEngine.BlockchainNode("Sepolia", {
            blockchainNodeId: created.blockchainNodeId,
            location: "us-central1",
            blockchainType: "ETHEREUM",
            ethereumDetails: {
              network: "TESTNET_SEPOLIA",
              nodeType: "FULL",
              executionClient: "GETH",
              consensusClient: "LIGHTHOUSE",
            },
            labels: { env: "prod", role: "node" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.blockchainNodeId).toEqual(created.blockchainNodeId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "node" });

      const refetched = yield* bne.getProjectsLocationsBlockchainNodes({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("node");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:blockchainnodeengine", "live"],
    timeout: 3_600_000,
  },
);
